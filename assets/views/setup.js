import { api } from '../api.js';
import { navigate } from '../app.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Erst-Setup nach Aktivierung von REQUIRE_AUTH_TOKEN.
 * Drei mögliche Zustände:
 *   1. Auth ist (noch) aus → Hinweis, wie man sie aktiviert
 *   2. Auth ist an, kein Admin → Setup-Wizard (activate → cat-Anleitung → redeem)
 *   3. Auth ist an, Admin existiert → Weiterleitung auf /geraete
 */
export async function renderSetup(root) {
    root.innerHTML = `<section><h1>Setup</h1><p class="muted">Lade Status…</p></section>`;
    let status;
    try {
        status = await api.getAuthStatus();
    } catch (err) {
        root.innerHTML = `<section><h1>Setup</h1>
            <p class="error">Status nicht erreichbar: ${escapeHtml(err.message)}</p></section>`;
        return;
    }

    if (!status.require_auth) {
        root.innerHTML = `
            <section>
                <h1>Authentifizierung deaktiviert</h1>
                <p>Die App läuft aktuell ohne Auth — jeder mit Zugriff auf den Server kann sie nutzen.</p>
                <p>Um Geräte-basierte Authentifizierung zu aktivieren:</p>
                <ol>
                    <li>Auf dem Server: <code>api/bootstrap.php</code> öffnen</li>
                    <li>Zeile <code>const REQUIRE_AUTH_TOKEN = false;</code> ändern auf <code>true</code></li>
                    <li>Diese Seite neu laden</li>
                </ol>
                <p class="muted">Solange das nicht der Fall ist, gilt das aktuelle „LAN/Single-Household"-Modell aus DEVELOPER.md Sektion 10.X.</p>
                <p><a href="." data-link class="btn">Zur Übersicht</a></p>
            </section>
        `;
        return;
    }

    if (status.has_admin) {
        // Schon eingerichtet — weiterleiten
        navigate('/geraete', true);
        return;
    }

    // Setup-Wizard
    if (!status.setup_token_pending) {
        root.innerHTML = `
            <section>
                <h1>Erst-Einrichtung</h1>
                <p>Die Authentifizierung ist aktiviert, aber noch kein Admin-Gerät eingerichtet. Klicke auf den Button — der Server erzeugt einen einmaligen Setup-Token und legt ihn als Datei auf dem Server ab. Du brauchst dann SSH-/SFTP-Zugriff um den Token zu lesen.</p>
                <p><button type="button" id="activate" class="btn primary">Setup-Token erzeugen</button></p>
                <div id="status"></div>
            </section>
        `;
        root.querySelector('#activate').addEventListener('click', async () => {
            const statusEl = root.querySelector('#status');
            statusEl.innerHTML = `<p class="muted">Erzeuge…</p>`;
            try {
                await api.activateSetup();
                renderSetup(root);
            } catch (err) {
                statusEl.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
            }
        });
        return;
    }

    // Token wurde generiert, jetzt einlösen
    root.innerHTML = `
        <section>
            <h1>Setup-Token einlösen</h1>
            <p>Ein Setup-Token wurde auf dem Server in <code>data/admin_setup_token.txt</code> abgelegt. Hol ihn dir per SSH:</p>
            <pre>cat &lt;app-pfad&gt;/data/admin_setup_token.txt</pre>
            <p>Den 64-stelligen Hex-Token hier einfügen:</p>
            <p>
                <input type="text" id="token" maxlength="64" placeholder="64 Hex-Zeichen" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:100%;font-family:ui-monospace,monospace;font-size:0.9rem;padding:0.5rem;">
            </p>
            <p>
                <button type="button" id="redeem" class="btn primary">Einlösen</button>
            </p>
            <div id="status"></div>
        </section>
    `;
    const tokenInput = root.querySelector('#token');
    tokenInput.focus();
    root.querySelector('#redeem').addEventListener('click', async () => {
        const statusEl = root.querySelector('#status');
        const tok = tokenInput.value.trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(tok)) {
            statusEl.innerHTML = `<p class="error">Token muss 64 Hex-Zeichen sein.</p>`;
            return;
        }
        statusEl.innerHTML = `<p class="muted">Prüfe…</p>`;
        try {
            await api.redeemSetupToken(tok);
            statusEl.innerHTML = `<p class="success">✓ Eingeloggt. Weiterleitung…</p>`;
            // Web-Admin nutzt Cookie — also keinen Bearer-Token in localStorage.
            // Hauptseite laden, normales Flow.
            setTimeout(() => navigate('/', true), 600);
        } catch (err) {
            statusEl.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    });
}
