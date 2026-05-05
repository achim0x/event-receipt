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
    $stmt = $db->prepare('SELECT id, titel, kategorie, quelle, zubereitungszeit, daten, erstellt_am FROM rezepte WHERE id = :id');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();

    if (!$row) {
        json_error('Rezept nicht gefunden', 404);
    }
    $row['daten'] = json_decode($row['daten'], true);
    json_response($row);
}

function handleGetList(PDO $db): void {
    $suche = trim((string) ($_GET['suche'] ?? ''));
    $kategorie = trim((string) ($_GET['kategorie'] ?? ''));

    $sql = 'SELECT id, titel, kategorie, quelle, zubereitungszeit, erstellt_am FROM rezepte WHERE 1=1';
    $params = [];
    if ($suche !== '') {
        $sql .= ' AND titel LIKE :suche';
        $params[':suche'] = '%' . $suche . '%';
    }
    if ($kategorie !== '') {
        $sql .= ' AND kategorie = :kategorie';
        $params[':kategorie'] = $kategorie;
    }
    $sql .= ' ORDER BY titel COLLATE NOCASE ASC';

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    json_response($stmt->fetchAll());
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
               daten = :daten
         WHERE id = :id
    ');
    $up->execute([
        ':titel' => (string) $normalized['title'],
        ':kategorie' => isset($normalized['category']) ? (string) $normalized['category'] : null,
        ':quelle' => isset($normalized['source']) ? (string) $normalized['source'] : null,
        ':zubereitungszeit' => isset($normalized['preparation_time']) ? (string) $normalized['preparation_time'] : null,
        ':daten' => json_encode($normalized, JSON_UNESCAPED_UNICODE),
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
