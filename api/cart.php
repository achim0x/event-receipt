<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

const MAX_CART_BYTES = 1024 * 1024;  // 1 MB — snapshot kann groß werden

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'POST') {
    $override = strtoupper((string) ($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'] ?? $_GET['_method'] ?? ''));
    if ($override === 'PUT') $method = 'PUT';
}

const MAX_CART_ITEMS = 200;       // Defensiv gegen Cart-Bombing
const MAX_CART_TITEL_LEN = 200;

function sanitize_cart_items(mixed $items): array {
    if (!is_array($items)) return [];
    $out = [];
    foreach ($items as $it) {
        if (!is_array($it) || !isset($it['id'])) continue;
        $titel = isset($it['titel']) ? (string) $it['titel'] : '';
        // Control-Chars raus, auf max Länge kürzen
        $titel = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', $titel) ?? $titel;
        $titel = function_exists('mb_substr')
            ? mb_substr(trim($titel), 0, MAX_CART_TITEL_LEN, 'UTF-8')
            : substr(trim($titel), 0, MAX_CART_TITEL_LEN);
        $out[] = [
            'id' => (int) $it['id'],
            'titel' => $titel,
            'personen' => max(1, min(9999, (int) ($it['personen'] ?? 1))),
        ];
        if (count($out) >= MAX_CART_ITEMS) break;
    }
    return $out;
}

function encode_snapshot(mixed $snapshot): string {
    // Snapshot ist Map<id, recipeData>. Leer → '{}', sonst JSON-encode.
    // Wir codieren ohne JSON_FORCE_OBJECT, weil PHP für int-Keys das Object-
    // Format selbst wählt (sobald Keys nicht 0..n sind).
    if (!is_array($snapshot) || empty($snapshot)) return '{}';
    $encoded = json_encode($snapshot, JSON_UNESCAPED_UNICODE);
    return $encoded === false ? '{}' : $encoded;
}

if ($method === 'GET') {
    $stmt = $db->prepare('SELECT items, snapshot, updated_at FROM einkaufsliste_aktuell WHERE id = 1');
    $stmt->execute();
    $row = $stmt->fetch();
    $items = $row ? json_decode($row['items'], true) : [];
    $snapshot = $row ? json_decode($row['snapshot'] ?? '{}', true) : [];
    json_response([
        'items' => is_array($items) ? $items : [],
        'snapshot' => is_array($snapshot) ? $snapshot : new stdClass,
        'updated_at' => $row['updated_at'] ?? null,
    ]);
}

if ($method === 'PUT') {
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > MAX_CART_BYTES) {
        json_error('Cart zu groß (max. 1 MB)', 413);
    }
    try {
        $body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        json_error('Ungültiges JSON: ' . $e->getMessage(), 400);
    }
    if (!is_array($body) || !array_key_exists('items', $body)) {
        json_error('Feld "items" erforderlich', 400);
    }
    $clean = sanitize_cart_items($body['items']);
    $snapshot = $body['snapshot'] ?? [];

    $stmt = $db->prepare('
        INSERT INTO einkaufsliste_aktuell (id, items, snapshot, updated_at)
        VALUES (1, :items, :snapshot, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            items = excluded.items,
            snapshot = excluded.snapshot,
            updated_at = CURRENT_TIMESTAMP
    ');
    $stmt->execute([
        ':items' => json_encode($clean, JSON_UNESCAPED_UNICODE),
        ':snapshot' => encode_snapshot($snapshot),
    ]);

    json_response([
        'items' => $clean,
        'snapshot' => is_array($snapshot) ? $snapshot : new stdClass,
    ]);
}

json_error('Method not allowed', 405);
