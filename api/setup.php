<?php
declare(strict_types=1);

// Setup-Flow für den allerersten Admin nach Aktivierung von
// REQUIRE_AUTH_TOKEN. Verläuft in drei Schritten:
//
//   GET ?action=status           → liefert require_auth / has_admin /
//                                   setup_token_pending Flags
//   POST ?action=activate        → schreibt einen einmaligen Setup-Token in
//                                   data/admin_setup_token.txt (nur lesbar
//                                   für den Server-Admin via SSH/SFTP). Idempotent.
//   POST ?action=redeem-setup    → Body {token}; tauscht den Setup-Token
//                                   gegen ein Web-Admin-Geräte-Token. Legt das
//                                   Gerät in der DB an und setzt das HttpOnly-
//                                   Cookie 'rezepte_session'. Löscht den Setup-
//                                   Token-File.
//
// Alle Endpunkte überspringen ensure_authenticated() — sonst wäre Setup
// nach Aktivierung des Auth-Locks unerreichbar.

define('SKIP_AUTH', true);
require __DIR__ . '/bootstrap.php';

const SETUP_TOKEN_FILE = __DIR__ . '/../data/admin_setup_token.txt';

function read_setup_token_file(): ?string {
    if (!is_file(SETUP_TOKEN_FILE) || !is_readable(SETUP_TOKEN_FILE)) return null;
    $raw = @file_get_contents(SETUP_TOKEN_FILE);
    if (!is_string($raw)) return null;
    $raw = trim($raw);
    return preg_match('/^[a-f0-9]{64}$/', $raw) ? $raw : null;
}

function delete_setup_token_file(): void {
    if (is_file(SETUP_TOKEN_FILE)) @unlink(SETUP_TOKEN_FILE);
}

function has_admin(PDO $db): bool {
    $stmt = $db->query("SELECT COUNT(*) FROM geraete WHERE typ = 'web' AND aktiv = 1");
    return (int) $stmt->fetchColumn() > 0;
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

if ($method === 'GET' && ($action === '' || $action === 'status')) {
    // is_authenticated nutzt current_geraet() — das prüft Bearer-Token
    // ODER Cookie. Wenn beides fehlt, ist der aktuelle Request "anonym".
    // Frontend nutzt das im Auth-Gate, um anonyme Mobile-Browser sofort
    // auf /pair umzulenken (statt sie in eine leere Übersicht laufen
    // zu lassen wo die Pair-Seite unauffindbar wäre).
    json_response([
        'require_auth' => REQUIRE_AUTH_TOKEN,
        'has_admin' => has_admin($db),
        'setup_token_pending' => read_setup_token_file() !== null,
        'is_authenticated' => current_geraet() !== null,
        'can_manage_devices' => current_geraet_can_manage_devices(),
    ]);
}

if ($method === 'POST' && $action === 'activate') {
    if (!REQUIRE_AUTH_TOKEN) {
        json_error('Setup nicht erforderlich: REQUIRE_AUTH_TOKEN ist false', 400);
    }
    if (has_admin($db)) {
        json_error('Admin existiert bereits — Setup nicht mehr nötig', 409);
    }
    // Wenn der Token schon existiert: idempotent zurück
    if (read_setup_token_file() !== null) {
        json_response(['ok' => true, 'already_pending' => true]);
    }
    $token = bin2hex(random_bytes(32));
    $written = @file_put_contents(SETUP_TOKEN_FILE, $token . "\n");
    if ($written === false) {
        json_error('Konnte Setup-Token-Datei nicht schreiben — data/ schreibbar für www-data?', 500);
    }
    @chmod(SETUP_TOKEN_FILE, 0600);
    error_log('[rezepte-app] setup token written to ' . SETUP_TOKEN_FILE);
    json_response(['ok' => true]);
}

if ($method === 'POST' && $action === 'redeem-setup') {
    $raw = file_get_contents('php://input') ?: '';
    try {
        $body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        json_error('Ungültiges JSON', 400);
    }
    $supplied = isset($body['token']) ? trim((string) $body['token']) : '';
    if (!preg_match('/^[a-f0-9]{64}$/', $supplied)) {
        json_error('Token-Format ungültig', 400);
    }

    $expected = read_setup_token_file();
    if ($expected === null) {
        json_error('Kein Setup-Token verfügbar — erst "activate" aufrufen', 400);
    }
    if (!hash_equals($expected, $supplied)) {
        json_error('Setup-Token stimmt nicht', 401);
    }

    // Neuen, echten Web-Admin-Token generieren, in DB ablegen, als Cookie setzen.
    // Setup-Token-Einlösung ist der einzige Pfad, der is_admin=1 schreibt.
    $deviceToken = bin2hex(random_bytes(32));
    $stmt = $db->prepare("
        INSERT INTO geraete (token_hash, name, typ, is_admin)
        VALUES (:h, :name, 'web', 1)
    ");
    $stmt->execute([
        ':h' => hash_token($deviceToken),
        ':name' => 'Web Admin',
    ]);
    set_session_cookie($deviceToken);
    delete_setup_token_file();

    json_response([
        'ok' => true,
        'device' => [
            'id' => (int) $db->lastInsertId(),
            'name' => 'Web Admin',
            'typ' => 'web',
        ],
    ]);
}

json_error('Unbekannte action', 400);
