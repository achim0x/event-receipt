import { api, setToken } from '../api.js';
import { navigate } from '../app.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Code-Eingabe-View für Mobile / neue Web-Sessions. User gibt den auf
 * /geraete erzeugten 8-Zeichen-Code ein. Server tauscht ihn gegen den
 * echten Token, der landet in localStorage.
 */
export function renderPair(root) {
    root.innerHTML = `
        <section>
            <h1>Gerät koppeln</h1>
            <p class="muted">Bitte den 8-Zeichen-Pairing-Code eingeben, der dir auf einem bereits eingeloggten Gerät unter „Geräte" angezeigt wurde. Format: <code>XXXX-XXXX</code> (Bindestrich optional).</p>

            <p>
                <input type="text" id="code" maxlength="9" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false"
                    style="width:100%;font-family:ui-monospace,monospace;font-size:1.4rem;letter-spacing:0.15em;text-align:center;padding:0.75rem;text-transform:uppercase;">
            </p>
            <p>
                <button type="button" class="btn primary" id="submit" style="width:100%;font-size:1.05rem;padding:0.75rem;">Koppeln</button>
            </p>
            <div id="status"></div>

            <p class="muted small" style="margin-top:2rem;">
                Noch keinen Code? Auf einem schon eingeloggten Gerät auf <strong>Geräte</strong> gehen und „Pairing-Code erzeugen". Der Code ist 5 Minuten gültig.
            </p>
        </section>
    `;

    const codeInput = root.querySelector('#code');
    const statusEl = root.querySelector('#status');
    codeInput.focus();

    // Live-Format: nach 4 Zeichen automatisch Bindestrich anhängen, alles
    // andere als Buchstaben/Ziffern wegfiltern. Macht das Tippen angenehmer.
    codeInput.addEventListener('input', () => {
        let v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (v.length > 8) v = v.slice(0, 8);
        codeInput.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
    });

    async function submit() {
        const raw = codeInput.value.replace(/[^A-Z0-9]/g, '');
        if (raw.length !== 8) {
            statusEl.innerHTML = `<p class="error">Code muss 8 Zeichen lang sein.</p>`;
            return;
        }
        statusEl.innerHTML = `<p class="muted">Prüfe…</p>`;
        try {
            const result = await api.redeemPairCode(raw);
            if (!result.token) throw new Error('Server hat keinen Token geliefert');
            setToken(result.token);
            statusEl.innerHTML = `<p class="success">✓ Gerät „${escapeHtml(result.device?.name || 'unbenannt')}" gekoppelt. Weiterleitung…</p>`;
            setTimeout(() => navigate('/', true), 500);
        } catch (err) {
            statusEl.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    root.querySelector('#submit').addEventListener('click', submit);
    codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
}
