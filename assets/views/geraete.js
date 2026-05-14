import { api, clearToken } from '../api.js';
import { navigate } from '../app.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Verwaltung der gepairten Geräte. Nur erreichbar wenn der Aufrufer
 * authentifiziert ist (über App.js Auth-Gate). Funktionen:
 *  - Liste aller (auch revozierter) Geräte
 *  - Neues Gerät: erzeugt 8-Zeichen-Pairing-Code, zeigt ihn an,
 *    Mobile-User gibt ihn unter /pair ein
 *  - Widerrufen pro Gerät
 */
export async function renderGeraete(root) {
    root.innerHTML = `<section><h1>Geräte</h1><p class="muted">Lade…</p></section>`;
    await draw();

    async function draw() {
        let data;
        try {
            data = await api.listDevices();
        } catch (err) {
            root.innerHTML = `<section><h1>Geräte</h1>
                <p class="error">${escapeHtml(err.message)}</p></section>`;
            return;
        }

        const devices = data.devices || [];

        root.innerHTML = `
            <section>
                <h1>Geräte verwalten</h1>
                ${devices.length ? `
                    <table class="cart-table">
                        <thead><tr>
                            <th>Name</th><th>Typ</th><th>Letzte Nutzung</th><th></th>
                        </tr></thead>
                        <tbody>
                            ${devices.map(d => `
                                <tr data-id="${d.id}"${d.is_current ? ' data-self="1"' : ''}>
                                    <td>
                                        <strong>${escapeHtml(d.name)}</strong>
                                        ${d.is_current ? '<span class="tag">aktuelles Gerät</span>' : ''}
                                        ${d.is_admin ? '<span class="tag" style="background:#ffe9c4;color:#7a5200;">Admin</span>' : ''}
                                        ${!d.aktiv ? '<span class="tag" style="background:#fee;color:#900;">widerrufen</span>' : ''}
                                    </td>
                                    <td>${escapeHtml(d.typ)}</td>
                                    <td class="muted small">${escapeHtml(d.zuletzt_gesehen || 'noch nie')}</td>
                                    <td>
                                        ${d.aktiv
                                            ? `<button type="button" class="btn small danger revoke">🗑 ${d.is_current ? 'Eigenes Gerät widerrufen' : 'Widerrufen'}</button>`
                                            : ''}
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : '<p class="muted">Noch keine Geräte gepaired.</p>'}

                <h2>Neues Gerät pairen</h2>
                <div class="save-as-row">
                    <label class="save-as-label">Name (z.B. „Achims iPhone")
                        <input type="text" id="device-name" maxlength="80" placeholder="Gerätename" autocomplete="off">
                    </label>
                    <select id="device-typ" style="padding:0.5rem;border:1px solid var(--border);border-radius:4px;">
                        <option value="mobile">📱 Mobile</option>
                        <option value="web">💻 Web</option>
                    </select>
                    <button type="button" class="btn primary" id="create-pair">Pairing-Code erzeugen</button>
                </div>
                <div id="pair-result"></div>
            </section>
        `;

        root.querySelectorAll('tr[data-id] .revoke').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tr = btn.closest('tr');
                const id = parseInt(tr.dataset.id, 10);
                const isSelf = tr.dataset.self === '1';

                const message = isSelf
                    ? 'Dein EIGENES Gerät widerrufen? Du wirst direkt ausgeloggt und musst dich danach neu pairen (oder per Setup-Token wieder rein).\n\nWirklich fortfahren?'
                    : 'Dieses Gerät widerrufen? Es kann sich danach nicht mehr verbinden, bis es neu gepaired wird.';
                if (!confirm(message)) return;

                try {
                    const result = await api.revokeDevice(id);
                    if (result?.self_revoked || isSelf) {
                        // Server hat das Session-Cookie schon gecleared; wir
                        // werfen noch den Bearer-Token im localStorage weg
                        // (Mobile-PWA) und schicken zur Pair-Seite. Kein
                        // weiteres draw() — die nächste API-Anfrage würde
                        // ohnehin mit 401 zurückkommen.
                        clearToken();
                        alert('Eigenes Gerät widerrufen. Du wirst zur Pairing-Seite weitergeleitet.');
                        navigate('/pair', true);
                        return;
                    }
                    await draw();
                } catch (err) {
                    alert('Widerrufen fehlgeschlagen: ' + err.message);
                }
            });
        });

        const nameInput = root.querySelector('#device-name');
        const typSelect = root.querySelector('#device-typ');
        root.querySelector('#create-pair').addEventListener('click', async () => {
            const name = nameInput.value.trim();
            const typ = typSelect.value;
            if (!name) { alert('Bitte einen Namen eingeben.'); nameInput.focus(); return; }
            const resultEl = root.querySelector('#pair-result');
            resultEl.innerHTML = `<p class="muted">Erzeuge Code…</p>`;
            try {
                const r = await api.createPairCode(name, typ);
                const expiresInMin = Math.round(r.ttl_seconds / 60);
                const pairUrl = new URL('pair', location.href).toString();
                resultEl.innerHTML = `
                    <div class="warning-box">
                        <p><strong>Pairing-Code:</strong></p>
                        <p style="font-family:ui-monospace,monospace;font-size:2rem;letter-spacing:0.2em;text-align:center;margin:0.5rem 0;">${escapeHtml(r.code)}</p>
                        <p class="muted">Gültig für ${expiresInMin} Minuten.</p>
                        <p class="muted"><strong>So koppelst du das andere Gerät:</strong></p>
                        <ol class="muted">
                            <li>Auf dem Zielgerät (Handy/anderer Browser) die App-URL öffnen — du wirst automatisch zur Code-Eingabe geleitet.</li>
                            <li>Falls nicht: direkt auf <code>${escapeHtml(pairUrl)}</code> gehen.</li>
                            <li>Den oben angezeigten Code eingeben.</li>
                        </ol>
                    </div>
                `;
                nameInput.value = '';
                // Liste neu laden nach 1 Sekunde damit die Anzeige stehen bleibt
                // (kein automatisches draw — sonst verschwindet der Code sofort)
            } catch (err) {
                resultEl.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
            }
        });
    }
}
