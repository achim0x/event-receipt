<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/translation.php';

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

// Snapshot-Modus: wenn der Client einen `snapshot` (Map<id, {daten: ...}>) mitschickt,
// werden Rezeptdaten primär daraus genommen. IDs ohne Snapshot-Eintrag fallen
// auf die aktuelle rezepte-Tabelle zurück. So funktionieren gespeicherte Listen
// auch nach Rezept-Edits konsistent (= eingefrorenes Original).
$snapshotRaw = $payload['snapshot'] ?? [];
$snapshot = is_array($snapshotRaw) ? $snapshotRaw : [];

$datenById = [];
foreach ($snapshot as $key => $entry) {
    if (is_array($entry) && isset($entry['daten']) && is_array($entry['daten'])) {
        $datenById[(int) $key] = $entry['daten'];
    }
}

$dbIds = array_values(array_filter($ids, fn($id) => !isset($datenById[$id])));
if (!empty($dbIds)) {
    $placeholders = implode(',', array_fill(0, count($dbIds), '?'));
    $stmt = $db->prepare("SELECT id, daten FROM rezepte WHERE id IN ($placeholders)");
    $stmt->execute($dbIds);
    foreach ($stmt->fetchAll() as $row) {
        $datenById[(int) $row['id']] = json_decode($row['daten'], true);
    }
}

// Aggregation: name + unit (case-insensitiv). Die Rezept-interne `group`
// (z.B. "Teig", "Hauptzutaten") wird bewusst ignoriert — sie ist eine
// Kochstruktur-Information ohne Bedeutung für den Einkauf. So werden
// gleiche Zutaten aus verschiedenen Rezepten unabhängig von ihrer
// recipe-internen Gruppierung zu einer Position zusammengefasst.
$aggregat = [];

foreach ($ids as $id) {
    $rezept = $datenById[$id] ?? null;
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

            $department = trim((string) ($item['department'] ?? ''));

            if (!isset($aggregat[$key])) {
                $aggregat[$key] = [
                    'name' => $name,
                    'unit' => $unit,
                    'quantity' => 0.0,
                    'department' => $department,  // first-seen, gewinnt bei Konflikten
                ];
            } elseif ($aggregat[$key]['department'] === '' && $department !== '') {
                // Wenn bisher kein Department gesetzt war und ein späteres
                // Item es hat, das übernehmen — verbessert Klassifizierung
                $aggregat[$key]['department'] = $department;
            }
            $aggregat[$key]['quantity'] += $skaliert;
        }
    }
}

// Sammeln pro Department; Items ohne Department → "Sonstiges"
const SONSTIGES = 'Sonstiges';
$byDepartment = [];
foreach ($aggregat as $entry) {
    $menge = $entry['quantity'];
    if (abs($menge - round($menge)) < 0.001) {
        $menge = (int) round($menge);
    } else {
        $menge = round($menge, 2);
    }
    $dept = $entry['department'] !== '' ? $entry['department'] : SONSTIGES;
    $byDepartment[$dept][] = [
        'quantity' => $menge,
        'unit' => $entry['unit'],
        'name' => $entry['name'],
    ];
}

// Department-Reihenfolge: kanonisch wie in valid_departments() definiert,
// danach alphabetisch (unbekannte sollten dank normalize_departments_in_recipe
// nicht vorkommen, aber failsafe), Sonstiges am Ende.
$canonicalOrder = valid_departments();
$liste = [];
foreach ($canonicalOrder as $dept) {
    if (!empty($byDepartment[$dept])) {
        usort($byDepartment[$dept], fn($a, $b) => strcasecmp($a['name'], $b['name']));
        $liste[] = ['group' => $dept, 'items' => $byDepartment[$dept]];
        unset($byDepartment[$dept]);
    }
}
// Eventuelle Außenseiter (sollte nicht passieren wegen Validierung)
ksort($byDepartment, SORT_NATURAL | SORT_FLAG_CASE);
foreach ($byDepartment as $dept => $items) {
    if ($dept === SONSTIGES) continue;
    usort($items, fn($a, $b) => strcasecmp($a['name'], $b['name']));
    $liste[] = ['group' => $dept, 'items' => $items];
}
// Sonstiges immer ganz am Ende
if (!empty($byDepartment[SONSTIGES])) {
    usort($byDepartment[SONSTIGES], fn($a, $b) => strcasecmp($a['name'], $b['name']));
    $liste[] = ['group' => SONSTIGES, 'items' => $byDepartment[SONSTIGES]];
}

json_response(['liste' => $liste]);
