<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

const VALID_KATEGORIEN = ['zutaten', 'gewuerze', 'equipment'];

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'POST') {
    $override = strtoupper((string) ($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'] ?? $_GET['_method'] ?? ''));
    if ($override === 'DELETE') $method = 'DELETE';
}

if ($method === 'GET') {
    $stmt = $db->prepare('SELECT kategorie, schluessel FROM einkaufsliste_abgehakt');
    $stmt->execute();
    $result = ['zutaten' => [], 'gewuerze' => [], 'equipment' => []];
    foreach ($stmt->fetchAll() as $row) {
        $k = $row['kategorie'];
        if (isset($result[$k])) {
            $result[$k][] = $row['schluessel'];
        }
    }
    json_response($result);
}

if ($method === 'POST') {
    $raw = file_get_contents('php://input') ?: '';
    try {
        $body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        json_error('Ungültiges JSON: ' . $e->getMessage(), 400);
    }
    if (!is_array($body)) json_error('Body muss ein Objekt sein', 400);

    $kategorie = trim((string) ($body['kategorie'] ?? ''));
    $schluessel = trim((string) ($body['schluessel'] ?? ''));
    $checked = !empty($body['checked']);

    if (!in_array($kategorie, VALID_KATEGORIEN, true)) {
        json_error('kategorie muss zutaten/gewuerze/equipment sein', 400);
    }
    if ($schluessel === '') json_error('Feld "schluessel" erforderlich', 400);

    if ($checked) {
        $stmt = $db->prepare('
            INSERT INTO einkaufsliste_abgehakt (kategorie, schluessel, abgehakt_am)
            VALUES (:k, :s, CURRENT_TIMESTAMP)
            ON CONFLICT(kategorie, schluessel) DO UPDATE SET abgehakt_am = CURRENT_TIMESTAMP
        ');
        $stmt->execute([':k' => $kategorie, ':s' => $schluessel]);
    } else {
        $stmt = $db->prepare('DELETE FROM einkaufsliste_abgehakt WHERE kategorie = :k AND schluessel = :s');
        $stmt->execute([':k' => $kategorie, ':s' => $schluessel]);
    }
    json_response([
        'success' => true,
        'kategorie' => $kategorie,
        'schluessel' => $schluessel,
        'checked' => $checked,
    ]);
}

if ($method === 'DELETE') {
    $kategorie = trim((string) ($_GET['kategorie'] ?? ''));
    if ($kategorie === '') {
        $db->exec('DELETE FROM einkaufsliste_abgehakt');
        json_response(['success' => true, 'cleared' => 'all']);
    }
    if (!in_array($kategorie, VALID_KATEGORIEN, true)) {
        json_error('Ungültige Kategorie', 400);
    }
    $stmt = $db->prepare('DELETE FROM einkaufsliste_abgehakt WHERE kategorie = :k');
    $stmt->execute([':k' => $kategorie]);
    json_response(['success' => true, 'cleared' => $kategorie]);
}

json_error('Method not allowed', 405);
