<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/translation.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method not allowed', 405);
}

const MAX_SIZE = 1024 * 1024;

function read_payload(): string {
    if (!empty($_FILES['datei'])) {
        $f = $_FILES['datei'];
        if ($f['error'] !== UPLOAD_ERR_OK) {
            json_error('Upload-Fehler (Code ' . $f['error'] . ')', 400);
        }
        if ($f['size'] > MAX_SIZE) {
            json_error('Datei zu groß (max. 1 MB)', 413);
        }
        $raw = file_get_contents($f['tmp_name']);
        if ($raw === false) {
            json_error('Datei konnte nicht gelesen werden', 500);
        }
        return $raw;
    }

    $raw = file_get_contents('php://input') ?: '';
    if ($raw === '') {
        json_error('Keine Datei übermittelt (Feld "datei" erwartet)', 400);
    }
    if (strlen($raw) > MAX_SIZE) {
        json_error('Daten zu groß (max. 1 MB)', 413);
    }
    return $raw;
}

$raw = read_payload();

try {
    $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    json_error('Ungültiges JSON: ' . $e->getMessage(), 400);
}

$normalized = normalize_recipe($data);

$stmt = $db->prepare('
    INSERT INTO rezepte (titel, kategorie, quelle, zubereitungszeit, daten)
    VALUES (:titel, :kategorie, :quelle, :zubereitungszeit, :daten)
');
$stmt->execute([
    ':titel' => (string) $normalized['title'],
    ':kategorie' => isset($normalized['category']) ? (string) $normalized['category'] : null,
    ':quelle' => isset($normalized['source']) ? (string) $normalized['source'] : null,
    ':zubereitungszeit' => isset($normalized['preparation_time']) ? (string) $normalized['preparation_time'] : null,
    ':daten' => json_encode($normalized, JSON_UNESCAPED_UNICODE),
]);

$id = (int) $db->lastInsertId();
json_response(['success' => true, 'id' => $id], 201);
