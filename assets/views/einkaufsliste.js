import { api } from '../api.js';
import { cart } from '../app.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function formatQuantity(q) {
    if (q == null || q === '') return '';
    const n = typeof q === 'number' ? q : parseFloat(q);
    if (Number.isNaN(n)) return String(q);
    if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
    return n.toFixed(2).replace(/\.?0+$/, '');
}

function listToText(liste) {
    const lines = [];
    for (const grp of liste) {
        if (grp.group) lines.push(`# ${grp.group}`);
        for (const it of grp.items) {
            const q = formatQuantity(it.quantity);
            const u = it.unit || '';
            const parts = [q, u, it.name].filter(Boolean);
            lines.push('- ' + parts.join(' '));
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd() + '\n';
}

export function renderEinkaufsliste(root) {
    function draw() {
        const items = cart.all();

        root.innerHTML = `
            <section>
                <h1>Einkaufsliste</h1>
                ${items.length ? `
                    <table class="cart-table">
                        <thead><tr><th>Rezept</th><th>Personen</th><th></th></tr></thead>
                        <tbody>
                            ${items.map(r => `
                                <tr data-id="${r.id}">
                                    <td><a href="/rezept/${r.id}" data-link>${escapeHtml(r.titel)}</a></td>
                                    <td><input type="number" min="1" max="999" value="${r.personen}" class="personen-input"></td>
                                    <td><button type="button" class="btn small remove">Entfernen</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    <div class="row-buttons">
                        <button type="button" class="btn primary" id="generate">Liste generieren</button>
                        <button type="button" class="btn" id="clear">Alle entfernen</button>
                    </div>
                    <div id="ergebnis"></div>
                ` : `
                    <p class="muted">Noch keine Rezepte ausgewählt. <a href="/" data-link>Rezepte ansehen</a></p>
                `}
            </section>
        `;

        if (!items.length) return;

        root.querySelectorAll('tr[data-id]').forEach(tr => {
            const id = parseInt(tr.dataset.id, 10);
            tr.querySelector('.personen-input').addEventListener('change', (e) => {
                cart.setPersonen(id, e.target.value);
            });
            tr.querySelector('.remove').addEventListener('click', () => {
                cart.remove(id);
                draw();
            });
        });

        root.querySelector('#clear').addEventListener('click', () => {
            if (confirm('Alle Rezepte aus der Einkaufsliste entfernen?')) {
                cart.clear();
                draw();
            }
        });

        root.querySelector('#generate').addEventListener('click', generate);
    }

    async function generate() {
        const items = cart.all();
        const ergebnis = root.querySelector('#ergebnis');
        ergebnis.innerHTML = `<p class="muted">Generiere…</p>`;
        try {
            const data = await api.einkaufsliste(items.map(r => ({ id: r.id, personen: r.personen })));
            const liste = data.liste || [];

            if (!liste.length) {
                ergebnis.innerHTML = `<p class="muted">Keine Zutaten gefunden.</p>`;
                return;
            }

            ergebnis.innerHTML = `
                <div class="ergebnis">
                    <h2>Einkaufsliste</h2>
                    ${liste.map(grp => `
                        ${grp.group ? `<h3>${escapeHtml(grp.group)}</h3>` : ''}
                        <ul>
                            ${grp.items.map(it => `
                                <li>
                                    <label>
                                        <input type="checkbox">
                                        <strong>${escapeHtml(formatQuantity(it.quantity))}${it.unit ? ' ' + escapeHtml(it.unit) : ''}</strong>
                                        ${escapeHtml(it.name)}
                                    </label>
                                </li>
                            `).join('')}
                        </ul>
                    `).join('')}
                    <div class="row-buttons">
                        <button type="button" class="btn" id="copy">📋 Als Text kopieren</button>
                        <button type="button" class="btn" id="download">💾 Als .txt herunterladen</button>
                    </div>
                </div>
            `;

            const text = listToText(liste);

            ergebnis.querySelector('#copy').addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    alert('In Zwischenablage kopiert.');
                } catch {
                    alert('Kopieren fehlgeschlagen — bitte manuell aus der Liste kopieren.');
                }
            });
            ergebnis.querySelector('#download').addEventListener('click', () => {
                const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'einkaufsliste.txt';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            });
        } catch (err) {
            ergebnis.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    draw();
}
