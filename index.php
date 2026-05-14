<?php
// Mount-Point der App ermitteln, damit <base> die richtigen Pfade liefert.
// SCRIPT_NAME ist nach dem Apache-Rewrite das tatsächlich ausgeführte
// Script (z.B. /index.php oder /rezepte/index.php) — unabhängig davon
// welche SPA-URL der Browser angefragt hat.
$base = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\') . '/';
?>
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <base href="<?= htmlspecialchars($base, ENT_QUOTES, 'UTF-8') ?>">
    <title>Rezepte</title>
    <link rel="stylesheet" href="assets/style.css">

    <!-- PWA -->
    <link rel="manifest" href="manifest.webmanifest">
    <meta name="theme-color" content="#c0392b">

    <!-- iOS-spezifisch: Add-to-Homescreen Verhalten -->
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="apple-mobile-web-app-title" content="Rezepte">
    <link rel="apple-touch-icon" href="assets/icons/apple-touch-icon-180.png">
    <link rel="icon" type="image/svg+xml" href="assets/icons/icon.svg">
</head>
<body>
    <div class="offline-banner no-print" role="status" aria-live="polite">
        📶 Offline — Anzeigen geht, Änderungen am Server bis zur nächsten Verbindung deaktiviert
    </div>

    <header class="app-header">
        <div class="container">
            <a href="." data-link class="brand">🍳 Rezepte</a>
            <nav class="app-nav">
                <a href="." data-link>Übersicht</a>
                <a href="upload" data-link>Upload</a>
                <a href="einkaufsliste" data-link>
                    Einkaufsliste
                    <span class="badge" id="cart-badge" hidden>0</span>
                </a>
                <a href="geraete" data-link class="nav-geraete" hidden>Geräte</a>
            </nav>
        </div>
    </header>

    <main id="app" class="container"></main>

    <footer class="app-footer">
        <div class="container">
            Rezept-Datenbank · SQLite + PHP · Vanilla JS<br>
            <a href="https://www.gnu.org/licenses/gpl-3.0.html" rel="license noopener noreferrer" target="_blank">GPL-3.0</a>
            ·
            <a href="https://github.com/achim0x/event-receipt" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>
    </footer>

    <script type="module" src="assets/app.js"></script>
</body>
</html>
