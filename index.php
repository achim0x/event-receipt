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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <base href="<?= htmlspecialchars($base, ENT_QUOTES, 'UTF-8') ?>">
    <title>Rezepte</title>
    <link rel="stylesheet" href="assets/style.css">
</head>
<body>
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
            </nav>
        </div>
    </header>

    <main id="app" class="container"></main>

    <footer class="app-footer">
        <div class="container">Rezept-Datenbank · SQLite + PHP · Vanilla JS</div>
    </footer>

    <script type="module" src="assets/app.js"></script>
</body>
</html>
