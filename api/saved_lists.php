<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

const MAX_LIST_BYTES = 100 * 1024;
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

if ($method === 'GET') {
    $name = trim((string) ($_GET['name'] ?? ''));

    if ($name === '') {
        // Liste aller gespeicherten Listen (ohne items, nur Metadata)
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

    // Einzelne benannte Liste laden (mit items)
    $stmt = $db->prepare('SELECT name, items, gespeichert_am FROM einkaufsliste_gespeichert WHERE name = :n');
    $stmt->execute([':n' => $name]);
    $row = $stmt->fetch();
    if (!$row) json_error('Liste nicht gefunden', 404);
    $items = json_decode($row['items'], true);
    json_response([
        'name' => $row['name'],
        'gespeichert_am' => $row['gespeichert_am'],
        'items' => is_array($items) ? $items : [],
    ]);
}

if ($method === 'POST') {
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > MAX_LIST_BYTES) {
        json_error('Daten zu groß (max. 100 KB)', 413);
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

    // Upsert: gleiche Namen werden überschrieben
    $stmt = $db->prepare('
        INSERT INTO einkaufsliste_gespeichert (name, items, gespeichert_am)
        VALUES (:name, :items, CURRENT_TIMESTAMP)
        ON CONFLICT(name) DO UPDATE SET
            items = excluded.items,
            gespeichert_am = CURRENT_TIMESTAMP
    ');
    $stmt->execute([':name' => $name, ':items' => json_encode($clean, JSON_UNESCAPED_UNICODE)]);

    json_response(['success' => true, 'name' => $name, 'count' => count($clean)]);
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
