<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

const MAX_LIST_BYTES = 1024 * 1024;  // 1 MB (snapshot kann groß werden)
const MAX_NAME_LEN = 80;

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'POST') {
    $override = strtoupper((string) ($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'] ?? $_GET['_method'] ?? ''));
    if (in_array($override, ['DELETE', 'PUT'], true)) $method = $override;
}

function sanitize_cart_items_for_save(mixed $items): array {
    if (!is_array($items)) return [];
    $out = [];
    foreach ($items as $it) {
        if (!is_array($it) || !isset($it['id'])) continue;
        $out[] = [
            'id' => (int) $it['id'],
            'titel' => isset($it['titel']) ? (string) $it['titel'] : '',
            'personen' => max(1, (int) ($it['personen'] ?? 1)),
        ];
    }
    return $out;
}

function name_length(string $s): int {
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
}

function build_recipe_snapshot(PDO $db, array $items): array {
    // Erzeugt {id: {titel, kategorie, quelle, zubereitungszeit, daten}}
    // aus der rezepte-Tabelle für alle im Cart enthaltenen IDs.
    if (empty($items)) return [];
    $ids = array_values(array_unique(array_map(fn($it) => (int) $it['id'], $items)));
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $db->prepare("SELECT id, titel, kategorie, quelle, zubereitungszeit, daten FROM rezepte WHERE id IN ($placeholders)");
    $stmt->execute($ids);
    $snap = [];
    foreach ($stmt->fetchAll() as $row) {
        $snap[(int) $row['id']] = [
            'titel' => $row['titel'],
            'kategorie' => $row['kategorie'],
            'quelle' => $row['quelle'],
            'zubereitungszeit' => $row['zubereitungszeit'],
            'daten' => json_decode($row['daten'], true),
        ];
    }
    return $snap;
}

function encode_snapshot_for_save(array $snapshot): string {
    if (empty($snapshot)) return '{}';
    $encoded = json_encode($snapshot, JSON_UNESCAPED_UNICODE);
    return $encoded === false ? '{}' : $encoded;
}

if ($method === 'GET') {
    $name = trim((string) ($_GET['name'] ?? ''));

    if ($name === '') {
        // Metadata-Liste (keine Items, keine Snapshots — schnelles Listing)
        $stmt = $db->prepare('SELECT name, items, gespeichert_am FROM einkaufsliste_gespeichert ORDER BY gespeichert_am DESC');
        $stmt->execute();
        $rows = $stmt->fetchAll();
        $list = [];
        foreach ($rows as $r) {
            $items = json_decode($r['items'], true);
            $list[] = [
                'name' => $r['name'],
                'gespeichert_am' => $r['gespeichert_am'],
                'count' => is_array($items) ? count($items) : 0,
            ];
        }
        json_response(['listen' => $list]);
    }

    // Einzelne Liste mit allem (items + snapshot)
    $stmt = $db->prepare('SELECT name, items, snapshot, gespeichert_am FROM einkaufsliste_gespeichert WHERE name = :n');
    $stmt->execute([':n' => $name]);
    $row = $stmt->fetch();
    if (!$row) json_error('Liste nicht gefunden', 404);
    $items = json_decode($row['items'], true);
    $snapshot = json_decode($row['snapshot'] ?? '{}', true);
    json_response([
        'name' => $row['name'],
        'gespeichert_am' => $row['gespeichert_am'],
        'items' => is_array($items) ? $items : [],
        'snapshot' => is_array($snapshot) ? $snapshot : new stdClass,
    ]);
}

if ($method === 'POST') {
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > MAX_LIST_BYTES) {
        json_error('Daten zu groß (max. 1 MB)', 413);
    }
    try {
        $body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        json_error('Ungültiges JSON: ' . $e->getMessage(), 400);
    }

    $name = trim((string) ($body['name'] ?? ''));
    if ($name === '') json_error('Feld "name" erforderlich', 400);
    if (name_length($name) > MAX_NAME_LEN) {
        json_error('Name zu lang (max. ' . MAX_NAME_LEN . ' Zeichen)', 400);
    }
    if (!array_key_exists('items', $body)) {
        json_error('Feld "items" erforderlich', 400);
    }
    $clean = sanitize_cart_items_for_save($body['items']);

    // Snapshot wird server-seitig aus der aktuellen rezepte-Tabelle gebaut.
    // Damit ist garantiert dass die gespeicherte Liste auf konsistentem Stand
    // ist — egal was der Client schickt. Das ist auch der Punkt: "save = freeze".
    $snapshot = build_recipe_snapshot($db, $clean);

    $stmt = $db->prepare('
        INSERT INTO einkaufsliste_gespeichert (name, items, snapshot, gespeichert_am)
        VALUES (:name, :items, :snapshot, CURRENT_TIMESTAMP)
        ON CONFLICT(name) DO UPDATE SET
            items = excluded.items,
            snapshot = excluded.snapshot,
            gespeichert_am = CURRENT_TIMESTAMP
    ');
    $stmt->execute([
        ':name' => $name,
        ':items' => json_encode($clean, JSON_UNESCAPED_UNICODE),
        ':snapshot' => encode_snapshot_for_save($snapshot),
    ]);

    json_response([
        'success' => true,
        'name' => $name,
        'count' => count($clean),
        'snapshot_size' => count($snapshot),
    ]);
}

if ($method === 'DELETE') {
    $name = trim((string) ($_GET['name'] ?? ''));
    if ($name === '') json_error('Parameter "name" erforderlich', 400);
    $stmt = $db->prepare('DELETE FROM einkaufsliste_gespeichert WHERE name = :n');
    $stmt->execute([':n' => $name]);
    if ($stmt->rowCount() === 0) json_error('Liste nicht gefunden', 404);
    json_response(['success' => true, 'name' => $name]);
}

json_error('Method not allowed', 405);
