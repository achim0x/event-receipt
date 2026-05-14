<?php
declare(strict_types=1);

// Auth-Verwaltung für eingeloggte Geräte plus den Code-Einlöse-Endpunkt
// für neu zu pairende Geräte.
//
//   GET ?action=devices          → Liste aller (auch inaktiver) Geräte
//   POST ?action=pair            → Body {name, typ}; erzeugt 8-Zeichen
//                                   Pairing-Code (15 min Ablauf). Aufrufendes
//                                   Gerät muss authentifiziert sein.
//   POST ?action=redeem-pair     → Body {code}; tauscht den Code gegen den
//                                   echten Token + Geräte-Eintrag. SKIP_AUTH
//                                   (sonst kann sich ja niemand neu pairen).
//   POST ?action=revoke          → Body {id}; setzt aktiv=0
//   POST ?action=logout          → Cookie clearen, eigenes Web-Gerät kann
//                                   sich aussperren (Token bleibt nutzbar bis
//                                   revoke)

// SKIP_AUTH nur für redeem-pair — andere Endpoints brauchen valid auth.
// Wir entscheiden anhand der ?action vor dem include.
$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST' && $action === 'redeem-pair') {
    define('SKIP_AUTH', true);
}

require __DIR__ . '/bootstrap.php';

// Erlaubte Zeichen: A-Z (ohne I/O — Lesbarkeit), 0-9 (ohne 0/1)
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LEN = 8;        // 8 Zeichen, anzeigeformat XXXX-XXXX
const PAIR_CODE_TTL_SECONDS = 900; // 15 Minuten

function generate_pair_code(): string {
    $alphabet = PAIR_CODE_ALPHABET;
    $alphabetLen = strlen($alphabet);
    $code = '';
    $bytes = random_bytes(PAIR_CODE_LEN);
    for ($i = 0; $i < PAIR_CODE_LEN; $i++) {
        $code .= $alphabet[ord($bytes[$i]) % $alphabetLen];
    }
    return $code;
}

function normalize_pair_code(string $input): string {
    // Whitespace + Bindestriche raus, uppercase
    $clean = strtoupper(preg_replace('/[\s-]+/', '', $input) ?? '');
    return $clean;
}

function format_pair_code(string $code): string {
    return substr($code, 0, 4) . '-' . substr($code, 4);
}

function require_authenticated_geraet(): array {
    $g = current_geraet();
    if ($g === null) json_error('Authentication required', 401);
    return $g;
}

if ($method === 'GET' && $action === 'devices') {
    // Auth required (oben durchgelaufen wenn nicht skip)
    if (REQUIRE_AUTH_TOKEN) require_authenticated_geraet();
    $stmt = $db->query('SELECT id, name, typ, erstellt_am, zuletzt_gesehen, aktiv FROM geraete ORDER BY id ASC');
    $rows = $stmt->fetchAll();
    $current = current_geraet();
    $list = [];
    foreach ($rows as $r) {
        $list[] = [
            'id' => (int) $r['id'],
            'name' => $r['name'],
            'typ' => $r['typ'],
            'erstellt_am' => $r['erstellt_am'],
            'zuletzt_gesehen' => $r['zuletzt_gesehen'],
            'aktiv' => (int) $r['aktiv'] === 1,
            'is_current' => $current && (int) $current['id'] === (int) $r['id'],
        ];
    }
    json_response(['devices' => $list]);
}

if ($method === 'POST' && $action === 'pair') {
    if (REQUIRE_AUTH_TOKEN) require_authenticated_geraet();
    $raw = file_get_contents('php://input') ?: '';
    try {
        $body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        json_error('Ungültiges JSON', 400);
    }
    $name = trim((string) ($body['name'] ?? ''));
    $typ = strtolower(trim((string) ($body['typ'] ?? 'mobile')));
    $nameLen = function_exists('mb_strlen') ? mb_strlen($name, 'UTF-8') : strlen($name);
    if ($name === '' || $nameLen > 80) {
        json_error('Feld "name" erforderlich (max 80 Zeichen)', 400);
    }
    if (!in_array($typ, ['mobile', 'web'], true)) {
        json_error('typ muss "mobile" oder "web" sein', 400);
    }

    // Vor dem Erzeugen: abgelaufene Codes aufräumen
    $db->exec("DELETE FROM pairing_codes WHERE expires_at < datetime('now')");

    // Maximal 5 Versuche um einen einmaligen Code zu finden (Kollision selten)
    $code = null;
    for ($attempt = 0; $attempt < 5; $attempt++) {
        $candidate = generate_pair_code();
        $exists = $db->prepare('SELECT 1 FROM pairing_codes WHERE code = :c');
        $exists->execute([':c' => $candidate]);
        if (!$exists->fetch()) { $code = $candidate; break; }
    }
    if ($code === null) json_error('Kollision — bitte erneut versuchen', 500);

    $expiresAt = gmdate('Y-m-d H:i:s', time() + PAIR_CODE_TTL_SECONDS);
    $ins = $db->prepare('
        INSERT INTO pairing_codes (code, name, typ, expires_at)
        VALUES (:c, :n, :t, :e)
    ');
    $ins->execute([':c' => $code, ':n' => $name, ':t' => $typ, ':e' => $expiresAt]);

    json_response([
        'code' => format_pair_code($code),
        'code_raw' => $code,
        'name' => $name,
        'typ' => $typ,
        'expires_at' => $expiresAt,
        'ttl_seconds' => PAIR_CODE_TTL_SECONDS,
    ]);
}

if ($method === 'POST' && $action === 'redeem-pair') {
    // KEIN auth-check — das ist der Einlöse-Endpoint
    $raw = file_get_contents('php://input') ?: '';
    try {
        $body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        json_error('Ungültiges JSON', 400);
    }
    $code = normalize_pair_code((string) ($body['code'] ?? ''));
    if (strlen($code) !== PAIR_CODE_LEN) {
        json_error('Pairing-Code-Format ungültig', 400);
    }

    // Aufräumen
    $db->exec("DELETE FROM pairing_codes WHERE expires_at < datetime('now')");

    $stmt = $db->prepare("
        SELECT name, typ, expires_at FROM pairing_codes
        WHERE code = :c AND expires_at >= datetime('now')
    ");
    $stmt->execute([':c' => $code]);
    $row = $stmt->fetch();
    if (!$row) {
        json_error('Pairing-Code ungültig oder abgelaufen', 404);
    }

    $deviceToken = bin2hex(random_bytes(32));
    $ins = $db->prepare('
        INSERT INTO geraete (token_hash, name, typ)
        VALUES (:h, :n, :t)
    ');
    $ins->execute([
        ':h' => hash_token($deviceToken),
        ':n' => $row['name'],
        ':t' => $row['typ'],
    ]);

    // Code verbrauchen
    $db->prepare('DELETE FROM pairing_codes WHERE code = :c')->execute([':c' => $code]);

    json_response([
        'token' => $deviceToken,
        'device' => [
            'id' => (int) $db->lastInsertId(),
            'name' => $row['name'],
            'typ' => $row['typ'],
        ],
    ]);
}

if ($method === 'POST' && $action === 'revoke') {
    if (REQUIRE_AUTH_TOKEN) require_authenticated_geraet();
    $raw = file_get_contents('php://input') ?: '';
    try {
        $body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        json_error('Ungültiges JSON', 400);
    }
    $id = (int) ($body['id'] ?? 0);
    if ($id <= 0) json_error('id erforderlich', 400);
    $stmt = $db->prepare('UPDATE geraete SET aktiv = 0 WHERE id = :id');
    $stmt->execute([':id' => $id]);
    if ($stmt->rowCount() === 0) json_error('Gerät nicht gefunden', 404);
    json_response(['ok' => true, 'id' => $id]);
}

if ($method === 'POST' && $action === 'logout') {
    // Cookie clearen — Server-Token bleibt aktiv (für Mobile-PWA), nur das
    // aktuelle Browser-Cookie wird gelöscht. Wer komplett aussperren will,
    // nutzt revoke.
    clear_session_cookie();
    json_response(['ok' => true]);
}

json_error('Unbekannte action', 400);
