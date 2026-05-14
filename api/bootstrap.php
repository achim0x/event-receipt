<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

// Defense-in-depth Security-Headers — werden auch von .htaccess gesetzt
// (für statische Antworten), hier nochmal explizit für PHP-Antworten falls
// mod_headers fehlt oder die .htaccess nicht greift.
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');

// CORS: Die App ist same-origin (Browser holt index.php und API vom gleichen
// Host). Cross-Origin-Zugriff ist nicht erforderlich und wäre nur ein
// CSRF-Vergrößerer. Wer das bewusst will, kann hier eine Whitelist setzen.
// Daher: KEINE Access-Control-Allow-*-Header.

// CSRF-Schutz für state-changing Methoden:
// Browser senden bei POST/PUT/DELETE *immer* einen Origin-Header (oder
// zumindest Referer). Wir akzeptieren nur Requests deren Origin/Referer
// zum eigenen HTTP_HOST passt. Tools wie curl ohne Origin/Referer dürfen
// weiter — die haben kein eingeloggtes Browser-Session-Risiko.
function ensure_same_origin(): void {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($method, ['POST', 'PUT', 'DELETE', 'PATCH'], true)) {
        return;
    }
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if ($host === '') return;  // kann nicht entscheiden — durchlassen

    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $referer = $_SERVER['HTTP_REFERER'] ?? '';

    if ($origin === '' && $referer === '') {
        // Kein Browser-Request (z.B. curl, fetch ohne credentials) — kein CSRF-Vektor
        return;
    }
    foreach ([$origin, $referer] as $candidate) {
        if ($candidate === '') continue;
        $parts = parse_url($candidate);
        $candHost = ($parts['host'] ?? '')
            . (isset($parts['port']) ? ':' . $parts['port'] : '');
        if ($candHost !== '' && $candHost === $host) {
            return;  // matches → OK
        }
    }
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden: cross-origin request'], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    // Wir haben keine CORS-Preflight-Anforderung mehr. Same-origin braucht
    // kein OPTIONS. Trotzdem 204 zurück, falls es irgendein Client probiert.
    http_response_code(204);
    exit;
}

ensure_same_origin();

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

// Exception-Handler: generic Message zum Client (kein internes Leaking),
// Details ins error_log für Server-Admin-Debugging.
set_exception_handler(function (Throwable $e): void {
    http_response_code(500);
    error_log(sprintf(
        '[rezepte-app] Uncaught %s: %s in %s:%d',
        get_class($e),
        $e->getMessage(),
        $e->getFile(),
        $e->getLine()
    ));
    echo json_encode(['error' => 'Internal server error'], JSON_UNESCAPED_UNICODE);
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

// Tags-Spalte (idempotent — wird bei Bestand-DBs nachgezogen). Speichert die
// Tags als comma-gewrappten String (",vegan,vegetarian,") damit ein einfaches
// LIKE-Filter '%,vegan,%' zuverlässig matched ohne Substring-Verwechslung.
// Leer ist NULL (oder '') — beides wird vom Filter als „kein Tag" gewertet.
$rezCols = $db->query("PRAGMA table_info(rezepte)")->fetchAll(PDO::FETCH_COLUMN, 1);
if (!in_array('tags', $rezCols, true)) {
    $db->exec("ALTER TABLE rezepte ADD COLUMN tags TEXT");
}

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

// --- Auth-Infrastructure ---------------------------------------------------
// Geräte-Tabelle für Token-basierte Authentifizierung.
$db->exec("
    CREATE TABLE IF NOT EXISTS geraete (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        typ TEXT NOT NULL DEFAULT 'mobile',
        erstellt_am DATETIME DEFAULT CURRENT_TIMESTAMP,
        zuletzt_gesehen DATETIME,
        aktiv INTEGER NOT NULL DEFAULT 1
    );
");

// Kurz-lebige Pairing-Codes für „neues Gerät koppeln". Web-UI generiert
// einen Code, Mobile löst ihn ein und bekommt dafür den echten Token.
// expires_at als ISO-String, wird beim Einlösen geprüft.
$db->exec("
    CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        typ TEXT NOT NULL,
        erstellt_am DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
    );
");

// --- Auth-Helpers ----------------------------------------------------------
function hash_token(string $token): string {
    // Token sind hochentropische 32-Byte-Zufallswerte → SHA-256 ist genug.
    // Wir speichern nur den Hash, der Klartext-Token landet nie in der DB.
    return hash('sha256', $token);
}

/**
 * Liefert das aktuelle Gerät (id, name, typ) oder null wenn kein gültiger
 * Token präsentiert wurde. Akzeptiert sowohl `Authorization: Bearer <token>`
 * (Mobile-PWA) als auch ein HttpOnly-Cookie `rezepte_session` (Web-UI).
 * Aktualisiert `zuletzt_gesehen` best-effort.
 */
function current_geraet(): ?array {
    global $db;
    $token = null;

    // Authorization-Header kann unter mod_php aus $_SERVER fehlen — Apache
    // strippt ihn vor PHP. Fallback-Reihenfolge: $_SERVER (PHP-FPM oder mit
    // RewriteRule durchgeschleift) → REDIRECT_HTTP_AUTHORIZATION (Rewrite-
    // Sideeffect) → apache_request_headers() (nur mit mod_php verfügbar).
    $auth = $_SERVER['HTTP_AUTHORIZATION']
        ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
        ?? '';
    if ($auth === '' && function_exists('apache_request_headers')) {
        $h = apache_request_headers();
        // Header-Lookup case-insensitive
        foreach ($h as $k => $v) {
            if (strcasecmp($k, 'Authorization') === 0) {
                $auth = $v;
                break;
            }
        }
    }
    if ($auth !== '' && preg_match('/^Bearer\s+([a-f0-9]{64})$/i', $auth, $m)) {
        $token = strtolower($m[1]);
    }
    if ($token === null && !empty($_COOKIE['rezepte_session'])) {
        $cookie = (string) $_COOKIE['rezepte_session'];
        if (preg_match('/^[a-f0-9]{64}$/i', $cookie)) {
            $token = strtolower($cookie);
        }
    }
    if ($token === null) return null;

    try {
        $stmt = $db->prepare('SELECT id, name, typ, aktiv FROM geraete WHERE token_hash = :h LIMIT 1');
        $stmt->execute([':h' => hash_token($token)]);
        $row = $stmt->fetch();
        if (!$row || (int) $row['aktiv'] !== 1) return null;

        // Best-effort: zuletzt_gesehen aktualisieren. Bei Fehler nicht eskalieren.
        try {
            $up = $db->prepare('UPDATE geraete SET zuletzt_gesehen = CURRENT_TIMESTAMP WHERE id = :id');
            $up->execute([':id' => $row['id']]);
        } catch (Throwable $e) {
            error_log('[rezepte-app] zuletzt_gesehen update failed: ' . $e->getMessage());
        }
        return $row;
    } catch (Throwable $e) {
        error_log('[rezepte-app] current_geraet lookup failed: ' . $e->getMessage());
        return null;
    }
}

/**
 * HttpOnly-Session-Cookie für die Web-UI setzen. SameSite=Strict + Secure
 * wenn HTTPS aktiv ist (auto-detect). Path = APP_BASE.
 */
function set_session_cookie(string $token): void {
    $base = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/\\') . '/';
    // Wir liegen unter /api/ — der Cookie soll aber für den App-Pfad gelten,
    // nicht nur fürs API-Subdir. Daher dirname von dirname.
    $appBase = rtrim(dirname(rtrim($base, '/')), '/\\') . '/';
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || ($_SERVER['SERVER_PORT'] ?? '') === '443';
    setcookie('rezepte_session', $token, [
        'expires' => 0,                        // Session-Cookie (Browser-Schließung)
        'path' => $appBase,
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}

function clear_session_cookie(): void {
    $base = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/\\') . '/';
    $appBase = rtrim(dirname(rtrim($base, '/')), '/\\') . '/';
    setcookie('rezepte_session', '', [
        'expires' => time() - 3600,
        'path' => $appBase,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}

/**
 * Blockt den Request mit 401 wenn REQUIRE_AUTH_TOKEN aktiv ist und kein
 * gültiges Gerät authentifiziert ist. Setup- und Pairing-Endpoints können
 * sich vor dem `require bootstrap.php` mit `define('SKIP_AUTH', true);`
 * vom Check ausnehmen.
 */
function ensure_authenticated(): void {
    if (!REQUIRE_AUTH_TOKEN) return;
    if (defined('SKIP_AUTH') && SKIP_AUTH) return;
    if (current_geraet() !== null) return;
    http_response_code(401);
    echo json_encode(['error' => 'Authentication required'], JSON_UNESCAPED_UNICODE);
    exit;
}

// Auth-Pflicht ist opt-in. Default: aus, damit das aktuelle LAN-/Single-
// Household-Modell weiter funktioniert. Wer die App ins Internet stellt,
// aktiviert das nach Phase 6 (Setup-UI) auf true.
const REQUIRE_AUTH_TOKEN = false;

ensure_authenticated();
