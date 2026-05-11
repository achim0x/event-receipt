<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_error('Method not allowed', 405);
}

$stmt = $db->prepare('SELECT daten FROM rezepte ORDER BY id ASC');
$stmt->execute();
$rows = $stmt->fetchAll();

$recipes = [];
foreach ($rows as $row) {
    $daten = json_decode($row['daten'], true);
    if (is_array($daten)) {
        $recipes[] = $daten;
    }
}

$payload = [
    'exported_at' => gmdate('c'),
    'version' => 1,
    'count' => count($recipes),
    'recipes' => $recipes,
];

// Browser bekommt Download-Trigger via Content-Disposition. JS-Clients dürfen
// das ignorieren und den JSON-Body direkt verwenden.
$filename = 'rezepte-export-' . gmdate('Y-m-d') . '.json';
header('Content-Disposition: attachment; filename="' . $filename . '"');

json_response($payload);
