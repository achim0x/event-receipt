<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function json_error(string $message, int $status = 400): never {
    http_response_code($status);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function json_response(mixed $data, int $status = 200): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

set_exception_handler(function (Throwable $e): void {
    http_response_code(500);
    echo json_encode(['error' => 'Server error: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
});

$dataDir = __DIR__ . '/../data';
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0775, true);
}

$db = new PDO('sqlite:' . $dataDir . '/rezepte.db');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

$db->exec("
    CREATE TABLE IF NOT EXISTS rezepte (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titel TEXT NOT NULL,
        kategorie TEXT,
        quelle TEXT,
        zubereitungszeit TEXT,
        daten TEXT NOT NULL,
        erstellt_am DATETIME DEFAULT CURRENT_TIMESTAMP
    );
");
$db->exec("CREATE INDEX IF NOT EXISTS idx_titel ON rezepte(titel);");
$db->exec("CREATE INDEX IF NOT EXISTS idx_kategorie ON rezepte(kategorie);");

// Singleton-Tabelle für die geteilte aktuelle Einkaufsliste — eine Zeile (id=1).
// `snapshot` ist optionaler Frozen-Daten-Blob (JSON Object {id: rezeptDaten})
// für den Snapshot-Modus: wenn nicht leer, werden Mengen/Zubereitung aus
// dem Snapshot statt der aktuellen rezepte-Tabelle gerechnet.
$db->exec("
    CREATE TABLE IF NOT EXISTS einkaufsliste_aktuell (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        items TEXT NOT NULL DEFAULT '[]',
        snapshot TEXT NOT NULL DEFAULT '{}',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
");
$db->exec("INSERT OR IGNORE INTO einkaufsliste_aktuell (id, items) VALUES (1, '[]');");

// Benannte gespeicherte Einkaufslisten. `snapshot` ist beim Save eingefrorene
// Kopie der relevanten Rezepte → spätere Änderungen wirken sich nicht aus.
$db->exec("
    CREATE TABLE IF NOT EXISTS einkaufsliste_gespeichert (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        items TEXT NOT NULL,
        snapshot TEXT NOT NULL DEFAULT '{}',
        gespeichert_am DATETIME DEFAULT CURRENT_TIMESTAMP
    );
");

// Idempotente Migration für Bestands-DBs (Tabellen vor Snapshot-Feature angelegt)
foreach (['einkaufsliste_aktuell', 'einkaufsliste_gespeichert'] as $tbl) {
    $cols = $db->query("PRAGMA table_info($tbl)")->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('snapshot', $cols, true)) {
        $db->exec("ALTER TABLE $tbl ADD COLUMN snapshot TEXT NOT NULL DEFAULT '{}'");
    }
}

// Abgehakte Einträge (geteilt zwischen allen Nutzern).
// Schlüssel ist normalisiert (lowercase) als 'name||unit' — Match überlebt
// Personenzahl-Änderungen (weil quantity nicht im Key steckt).
$db->exec("
    CREATE TABLE IF NOT EXISTS einkaufsliste_abgehakt (
        kategorie TEXT NOT NULL,
        schluessel TEXT NOT NULL,
        abgehakt_am DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kategorie, schluessel)
    );
");
