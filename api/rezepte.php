<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/translation.php';

const MAX_SIZE = 1024 * 1024;

$method = $_SERVER['REQUEST_METHOD'];

// Manche Frontends können kein PUT/DELETE — Override per Header oder Query
if ($method === 'POST') {
    $override = $_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'] ?? ($_GET['_method'] ?? '');
    $override = strtoupper((string) $override);
    if (in_array($override, ['PUT', 'DELETE'], true)) {
        $method = $override;
    }
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?? '';
$path = rtrim($path, '/');
$idMatch = preg_match('#/api/rezepte(?:\.php)?/(\d+)$#', $path, $m);
$id = $idMatch ? (int) $m[1] : null;

switch ($method) {
    case 'GET':
        $id !== null ? handleGetOne($db, $id) : handleGetList($db);
        break;
    case 'PUT':
        if ($id === null) json_error('ID erforderlich', 400);
        handlePut($db, $id);
        break;
    case 'DELETE':
        if ($id === null) json_error('ID erforderlich', 400);
        handleDelete($db, $id);
        break;
    default:
        json_error('Method not allowed', 405);
}

function handleGetOne(PDO $db, int $id): void {
    $stmt = $db->prepare('SELECT id, titel, kategorie, quelle, zubereitungszeit, daten, tags, rating, erstellt_am FROM rezepte WHERE id = :id');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();

    if (!$row) {
        json_error('Rezept nicht gefunden', 404);
    }
    $row['daten'] = json_decode($row['daten'], true);
    // Spalten-Wert (",vegan,…,") in flaches Array umsetzen — Frontend bekommt
    // immer eine Liste, auch bei NULL.
    $row['tags'] = column_to_tags($row['tags'] ?? null);
    $row['rating'] = (int) ($row['rating'] ?? 0);
    json_response($row);
}

function handleGetList(PDO $db): void {
    $suche = trim((string) ($_GET['suche'] ?? ''));
    $kategorie = trim((string) ($_GET['kategorie'] ?? ''));
    $tagFilter = trim((string) ($_GET['tag'] ?? ''));

    $sql = 'SELECT id, titel, kategorie, quelle, zubereitungszeit, tags, rating, erstellt_am FROM rezepte WHERE 1=1';
    $params = [];
    if ($suche !== '') {
        $sql .= ' AND titel LIKE :suche';
        $params[':suche'] = '%' . $suche . '%';
    }
    if ($kategorie !== '') {
        $sql .= ' AND kategorie = :kategorie';
        $params[':kategorie'] = $kategorie;
    }
    if ($tagFilter !== '') {
        // Canonicalisieren damit der User auch deutsche Tag-Werte via Query
        // schicken kann (?tag=vegetarisch). Unbekannte Werte erzeugen einen
        // garantiert leeren Match, kein 400 — der Filter ist Anzeige-bezogen.
        $canon = canonicalize_tag($tagFilter);
        if ($canon === null) {
            // Kein Match möglich, aber wir liefern leere Liste statt 400 zurück
            json_response([]);
        }
        $sql .= ' AND tags LIKE :tag';
        $params[':tag'] = '%,' . $canon . ',%';
    }
    $sql .= ' ORDER BY titel COLLATE NOCASE ASC';

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    // tags-Spalte in Array umsetzen für gleichmäßige Frontend-Verarbeitung
    foreach ($rows as &$r) {
        $r['tags'] = column_to_tags($r['tags'] ?? null);
        $r['rating'] = (int) ($r['rating'] ?? 0);
    }
    json_response($rows);
}

function handlePut(PDO $db, int $id): void {
    $stmt = $db->prepare('SELECT id FROM rezepte WHERE id = :id');
    $stmt->execute([':id' => $id]);
    if (!$stmt->fetch()) {
        json_error('Rezept nicht gefunden', 404);
    }

    $raw = file_get_contents('php://input') ?: '';
    if ($raw === '') {
        json_error('Body erforderlich', 400);
    }
    if (strlen($raw) > MAX_SIZE) {
        json_error('Daten zu groß (max. 1 MB)', 413);
    }
    try {
        $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        json_error('Ungültiges JSON: ' . $e->getMessage(), 400);
    }

    $normalized = normalize_recipe($data);

    $up = $db->prepare('
        UPDATE rezepte
           SET titel = :titel,
               kategorie = :kategorie,
               quelle = :quelle,
               zubereitungszeit = :zubereitungszeit,
               daten = :daten,
               tags = :tags,
               rating = :rating
         WHERE id = :id
    ');
    $up->execute([
        ':titel' => (string) $normalized['title'],
        ':kategorie' => isset($normalized['category']) ? (string) $normalized['category'] : null,
        ':quelle' => isset($normalized['source']) ? (string) $normalized['source'] : null,
        ':zubereitungszeit' => isset($normalized['preparation_time']) ? (string) $normalized['preparation_time'] : null,
        ':daten' => json_encode($normalized, JSON_UNESCAPED_UNICODE),
        ':tags' => tags_to_column($normalized['tags'] ?? []),
        ':rating' => (int) ($normalized['rating'] ?? 0),
        ':id' => $id,
    ]);

    json_response(['success' => true, 'id' => $id]);
}

function handleDelete(PDO $db, int $id): void {
    $stmt = $db->prepare('DELETE FROM rezepte WHERE id = :id');
    $stmt->execute([':id' => $id]);
    if ($stmt->rowCount() === 0) {
        json_error('Rezept nicht gefunden', 404);
    }
    json_response(['success' => true, 'id' => $id]);
}
