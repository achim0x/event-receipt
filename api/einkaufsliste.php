<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method not allowed', 405);
}

const BASIS_PERSONEN = 1;

$raw = file_get_contents('php://input') ?: '';
try {
    $payload = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    json_error('Ungültiges JSON: ' . $e->getMessage(), 400);
}

if (!is_array($payload) || empty($payload['rezepte']) || !is_array($payload['rezepte'])) {
    json_error('Feld "rezepte" (Array) erforderlich', 400);
}

$ids = [];
$personenById = [];
foreach ($payload['rezepte'] as $entry) {
    if (!is_array($entry) || !isset($entry['id'])) {
        continue;
    }
    $id = (int) $entry['id'];
    $personen = max(1, (int) ($entry['personen'] ?? BASIS_PERSONEN));
    $ids[] = $id;
    $personenById[$id] = $personen;
}

if (empty($ids)) {
    json_error('Keine gültigen Rezept-IDs', 400);
}

$placeholders = implode(',', array_fill(0, count($ids), '?'));
$stmt = $db->prepare("SELECT id, daten FROM rezepte WHERE id IN ($placeholders)");
$stmt->execute($ids);
$rows = $stmt->fetchAll();

// Aggregation: name + unit (case-insensitiv). Die Rezept-interne `group`
// (z.B. "Teig", "Hauptzutaten") wird bewusst ignoriert — sie ist eine
// Kochstruktur-Information ohne Bedeutung für den Einkauf. So werden
// gleiche Zutaten aus verschiedenen Rezepten unabhängig von ihrer
// recipe-internen Gruppierung zu einer Position zusammengefasst.
$aggregat = [];

foreach ($rows as $row) {
    $id = (int) $row['id'];
    $rezept = json_decode($row['daten'], true);
    if (!is_array($rezept) || empty($rezept['ingredients']) || !is_array($rezept['ingredients'])) {
        continue;
    }
    $faktor = $personenById[$id] / BASIS_PERSONEN;

    foreach ($rezept['ingredients'] as $gruppe) {
        if (!is_array($gruppe)) {
            continue;
        }
        $items = $gruppe['items'] ?? [];
        if (!is_array($items)) {
            continue;
        }
        foreach ($items as $item) {
            if (!is_array($item)) {
                continue;
            }
            $name = trim((string) ($item['name'] ?? ''));
            if ($name === '') {
                continue;
            }
            $unit = trim((string) ($item['unit'] ?? ''));
            $quantity = (float) ($item['quantity'] ?? 0);
            $skaliert = $quantity * $faktor;

            $lowerName = function_exists('mb_strtolower') ? mb_strtolower($name) : strtolower($name);
            $lowerUnit = function_exists('mb_strtolower') ? mb_strtolower($unit) : strtolower($unit);
            $key = $lowerName . '||' . $lowerUnit;

            if (!isset($aggregat[$key])) {
                $aggregat[$key] = [
                    'name' => $name,
                    'unit' => $unit,
                    'quantity' => 0.0,
                ];
            }
            $aggregat[$key]['quantity'] += $skaliert;
        }
    }
}

$items = [];
foreach ($aggregat as $entry) {
    $menge = $entry['quantity'];
    if (abs($menge - round($menge)) < 0.001) {
        $menge = (int) round($menge);
    } else {
        $menge = round($menge, 2);
    }
    $items[] = [
        'quantity' => $menge,
        'unit' => $entry['unit'],
        'name' => $entry['name'],
    ];
}

usort($items, fn($a, $b) => strcasecmp($a['name'], $b['name']));

// Antwort behält das bestehende Listen-Format bei (Array von Gruppen-
// Objekten), aber mit genau einem Eintrag mit leerer group — das
// Frontend rendert dann einen flachen <ul> ohne Gruppen-Header.
$liste = $items ? [['group' => '', 'items' => $items]] : [];

json_response(['liste' => $liste]);
