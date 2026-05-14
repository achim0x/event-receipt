<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/translation.php';  // sanitize_text, normalize_single_unit, canonicalize_department

const MAX_CART_BYTES = 1024 * 1024;  // 1 MB — snapshot kann groß werden
const MAX_CUSTOM_ITEMS = 200;

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

/**
 * Sanitisiert die freien Zutaten der Einkaufsliste (Items die NICHT aus
 * einem Rezept stammen). Schema pro Eintrag: {quantity, unit, name,
 * department?}. Einheiten werden wie bei Rezept-Items normalisiert (kg→g,
 * EL→g etc); unbekannte Einheiten landen 1:1 in der Ausgabe (kein 400,
 * der Aggregator gruppiert „Stück Brötchen" und „Brötchen" dann eben in
 * unterschiedlichen Buckets — kein Datenverlust). Department wird via
 * canonicalize_department auf EN-Slug normalisiert oder weggelassen.
 */
function sanitize_custom_items(mixed $items): array {
    if (!is_array($items)) return [];
    $out = [];
    foreach ($items as $it) {
        if (!is_array($it)) continue;
        $name = sanitize_text($it['name'] ?? '', MAX_INGREDIENT_NAME);
        if ($name === '') continue;

        $unit = sanitize_text($it['unit'] ?? '', MAX_UNIT_LEN);
        $rawQty = $it['quantity'] ?? 0;
        $quantity = is_numeric($rawQty) ? (float) $rawQty : 0.0;
        if ($unit !== '') {
            $norm = normalize_single_unit($quantity, $unit);
            if ($norm !== null) {
                [$quantity, $unit] = $norm;
            }
            // unbekannte Einheit: $unit bleibt was der User getippt hat
        }

        $clean = [
            'quantity' => $quantity,
            'unit' => $unit,
            'name' => $name,
        ];

        $dept = sanitize_text($it['department'] ?? '', MAX_DEPT_LEN);
        if ($dept !== '') {
            $canon = canonicalize_department($dept);
            if ($canon !== null && $canon !== '') {
                $clean['department'] = $canon;
            }
        }

        $out[] = $clean;
        if (count($out) >= MAX_CUSTOM_ITEMS) break;
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
    $stmt = $db->prepare('SELECT items, snapshot, custom_items, updated_at FROM einkaufsliste_aktuell WHERE id = 1');
    $stmt->execute();
    $row = $stmt->fetch();
    $items = $row ? json_decode($row['items'], true) : [];
    $snapshot = $row ? json_decode($row['snapshot'] ?? '{}', true) : [];
    $custom = $row ? json_decode($row['custom_items'] ?? '[]', true) : [];
    json_response([
        'items' => is_array($items) ? $items : [],
        'snapshot' => is_array($snapshot) ? $snapshot : new stdClass,
        'custom_items' => is_array($custom) ? $custom : [],
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
    // custom_items ist optional — Bestandsclients die das Feld noch nicht
    // schicken sollen den Cart-Update nicht versehentlich leeren. Daher:
    // nur überschreiben wenn der Key explizit im Body ist.
    $customProvided = array_key_exists('custom_items', $body);
    $customClean = $customProvided ? sanitize_custom_items($body['custom_items']) : null;

    if ($customProvided) {
        $stmt = $db->prepare('
            INSERT INTO einkaufsliste_aktuell (id, items, snapshot, custom_items, updated_at)
            VALUES (1, :items, :snapshot, :custom, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                items = excluded.items,
                snapshot = excluded.snapshot,
                custom_items = excluded.custom_items,
                updated_at = CURRENT_TIMESTAMP
        ');
        $stmt->execute([
            ':items' => json_encode($clean, JSON_UNESCAPED_UNICODE),
            ':snapshot' => encode_snapshot($snapshot),
            ':custom' => json_encode($customClean, JSON_UNESCAPED_UNICODE),
        ]);
    } else {
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
    }

    $response = [
        'items' => $clean,
        'snapshot' => is_array($snapshot) ? $snapshot : new stdClass,
    ];
    if ($customProvided) $response['custom_items'] = $customClean;
    json_response($response);
}

json_error('Method not allowed', 405);
