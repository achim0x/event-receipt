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
