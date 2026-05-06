<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

const MAX_CART_BYTES = 100 * 1024;

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'POST') {
    $override = strtoupper((string) ($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'] ?? $_GET['_method'] ?? ''));
    if ($override === 'PUT') $method = 'PUT';
}

/**
 * Räumt Cart-Items auf: nur {id, titel, personen} mit sinnvollen Typen.
 * Items ohne ID werden verworfen. Personen min 1.
 */
function sanitize_cart_items(mixed $items): array {
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

if ($method === 'GET') {
    $stmt = $db->prepare('SELECT items, updated_at FROM einkaufsliste_aktuell WHERE id = 1');
    $stmt->execute();
    $row = $stmt->fetch();
    $items = $row ? json_decode($row['items'], true) : [];
    json_response([
        'items' => is_array($items) ? $items : [],
        'updated_at' => $row['updated_at'] ?? null,
    ]);
}

if ($method === 'PUT') {
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > MAX_CART_BYTES) {
        json_error('Cart zu groß (max. 100 KB)', 413);
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

    $stmt = $db->prepare('
        INSERT INTO einkaufsliste_aktuell (id, items, updated_at)
        VALUES (1, :items, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            items = excluded.items,
            updated_at = CURRENT_TIMESTAMP
    ');
    $stmt->execute([':items' => json_encode($clean, JSON_UNESCAPED_UNICODE)]);

    json_response(['items' => $clean]);
}

json_error('Method not allowed', 405);
