<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/translation.php';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;  // 5 MB — kann viele Rezepte sein

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method not allowed', 405);
}

function read_import_payload(): string {
    if (!empty($_FILES['datei'])) {
        $f = $_FILES['datei'];
        if ($f['error'] !== UPLOAD_ERR_OK) {
            json_error('Upload-Fehler (Code ' . $f['error'] . ')', 400);
        }
        if ($f['size'] > MAX_IMPORT_BYTES) {
            json_error('Datei zu groß (max. 5 MB)', 413);
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
    if (strlen($raw) > MAX_IMPORT_BYTES) {
        json_error('Daten zu groß (max. 5 MB)', 413);
    }
    return $raw;
}

$raw = read_import_payload();

try {
    $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    json_error('Ungültiges JSON: ' . $e->getMessage(), 400);
}

// Akzeptiert zwei Formate:
// 1) {recipes: [...]} — vom export.php produzierter Wrapper
// 2) [...]            — bare Array von Rezepten
if (is_array($data) && isset($data['recipes']) && is_array($data['recipes'])) {
    $recipes = $data['recipes'];
} elseif (is_array($data) && array_is_list($data)) {
    $recipes = $data;
} else {
    json_error('JSON muss ein Array von Rezepten oder ein Objekt mit "recipes"-Feld sein', 400);
}

$dryRun = !empty($_POST['dry_run']) || !empty($_GET['dry_run']);

$imported = 0;
$failed = [];

$insert = $db->prepare('
    INSERT INTO rezepte (titel, kategorie, quelle, zubereitungszeit, daten, tags, rating)
    VALUES (:titel, :kategorie, :quelle, :zubereitungszeit, :daten, :tags, :rating)
');

foreach ($recipes as $i => $rezept) {
    try {
        $normalized = normalize_recipe_strict($rezept);
        if (!$dryRun) {
            $insert->execute([
                ':titel' => (string) $normalized['title'],
                ':kategorie' => isset($normalized['category']) ? (string) $normalized['category'] : null,
                ':quelle' => isset($normalized['source']) ? (string) $normalized['source'] : null,
                ':zubereitungszeit' => isset($normalized['preparation_time']) ? (string) $normalized['preparation_time'] : null,
                ':daten' => json_encode($normalized, JSON_UNESCAPED_UNICODE),
                ':tags' => tags_to_column($normalized['tags'] ?? []),
                ':rating' => (int) ($normalized['rating'] ?? 0),
            ]);
        }
        $imported++;
    } catch (RecipeValidationException $e) {
        $title = is_array($rezept) ? (string) ($rezept['title'] ?? $rezept['titel'] ?? '') : '';
        if ($title === '') $title = '(unbenannt)';
        $failed[] = [
            'index' => $i + 1,
            'title' => $title,
            'error' => $e->getMessage(),
        ];
    }
}

json_response([
    'total' => count($recipes),
    'imported' => $imported,
    'failed' => $failed,
    'dry_run' => $dryRun,
]);
