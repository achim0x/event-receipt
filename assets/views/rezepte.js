import { api } from '../api.js';
import { cart, navigate } from '../app.js';
import { displayUnit } from '../units.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function debounce(fn, ms = 250) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function formatQuantity(q) {
    if (q == null || q === '') return '';
    const n = typeof q === 'number' ? q : parseFloat(q);
    if (Number.isNaN(n)) return String(q);
    if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
    return n.toFixed(2).replace(/\.?0+$/, '');
}

export async function renderRezeptListe(root) {
    root.innerHTML = `
        <section>
            <h1>Rezepte</h1>
            <div class="toolbar">
                <input type="search" id="suche" placeholder="Suche nach Titel…" autofocus>
                <select id="kategorie">
                    <option value="">Alle Kategorien</option>
                </select>
            </div>
            <div id="liste" class="card-grid"><p class="muted">Lade…</p></div>
        </section>
    `;

    const sucheEl = root.querySelector('#suche');
    const katEl = root.querySelector('#kategorie');
    const listeEl = root.querySelector('#liste');

    let kategorien = new Set();

    async function loadAndRender() {
        const suche = sucheEl.value.trim();
        const kategorie = katEl.value;
        try {
            const rezepte = await api.listRezepte({ suche, kategorie });
            renderListe(rezepte);
            // Kategorien beim ersten Laden ohne Filter erfassen
            if (!suche && !kategorie) {
                kategorien = new Set(rezepte.map(r => r.kategorie).filter(Boolean));
                renderKategorien();
            }
        } catch (err) {
            listeEl.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    function renderKategorien() {
        const current = katEl.value;
        const opts = ['<option value="">Alle Kategorien</option>'];
        for (const k of [...kategorien].sort()) {
            opts.push(`<option value="${escapeHtml(k)}"${k === current ? ' selected' : ''}>${escapeHtml(k)}</option>`);
        }
        katEl.innerHTML = opts.join('');
    }

    function renderListe(rezepte) {
        if (!rezepte.length) {
            listeEl.innerHTML = `<p class="muted">Keine Rezepte gefunden. <a href="upload" data-link>Lade dein erstes Rezept hoch.</a></p>`;
            return;
        }
        listeEl.innerHTML = rezepte.map(r => `
            <a class="card" href="rezept/${r.id}" data-link>
                <h3>${escapeHtml(r.titel)}</h3>
                ${r.kategorie ? `<span class="tag">${escapeHtml(r.kategorie)}</span>` : ''}
                ${r.zubereitungszeit ? `<p class="muted">⏱ ${escapeHtml(r.zubereitungszeit)}</p>` : ''}
                ${r.quelle ? `<p class="muted">📖 ${escapeHtml(r.quelle)}</p>` : ''}
            </a>
        `).join('');
    }

    sucheEl.addEventListener('input', debounce(loadAndRender, 200));
    katEl.addEventListener('change', loadAndRender);

    await loadAndRender();
}

export async function renderRezeptDetail(root, id) {
    root.innerHTML = `<p class="muted">Lade Rezept…</p>`;
    let rezept;
    try {
        rezept = await api.getRezept(id);
    } catch (err) {
        root.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p><p><a href="." data-link>Zurück</a></p>`;
        return;
    }

    const daten = rezept.daten || {};
    const ingredients = Array.isArray(daten.ingredients) ? daten.ingredients : [];
    const spices = Array.isArray(daten.spices) ? daten.spices.filter(Boolean) : [];
    const preparation = Array.isArray(daten.preparation) ? daten.preparation.filter(Boolean) : [];
    const tips = Array.isArray(daten.tips) ? daten.tips.filter(Boolean) : [];
    const equipment = Array.isArray(daten.kitchen_equipment) ? daten.kitchen_equipment : [];

    const inCart = cart.has(rezept.id);
    const startPersonen = inCart ? (cart.all().find(c => c.id === rezept.id)?.personen || 1) : 1;

    root.innerHTML = `
        <article class="rezept">
            <p><a href="." data-link>← Zurück zur Übersicht</a></p>
            <h1>${escapeHtml(rezept.titel)}</h1>
            <div class="meta">
                ${rezept.kategorie ? `<span class="tag">${escapeHtml(rezept.kategorie)}</span>` : ''}
                ${rezept.zubereitungszeit ? `<span>⏱ ${escapeHtml(rezept.zubereitungszeit)}</span>` : ''}
                ${rezept.quelle ? `<span>📖 ${escapeHtml(rezept.quelle)}</span>` : ''}
            </div>

            <div class="personen-box">
                <label>Personen:
                    <input type="number" id="personen" min="1" max="999" value="${startPersonen}">
                </label>
                <button id="add-cart" type="button" class="btn primary">
                    ${inCart ? '✓ In Einkaufsliste — Personen aktualisieren' : '+ Zur Einkaufsliste'}
                </button>
                <a href="rezept/${rezept.id}/bearbeiten" data-link class="btn">✎ Bearbeiten</a>
                <button id="export-rezept" type="button" class="btn">💾 Als JSON</button>
                <button id="delete-rezept" type="button" class="btn danger">🗑 Löschen</button>
            </div>

            ${ingredients.length ? `
                <h2>Zutaten</h2>
                <div id="zutaten-bereich">${renderZutaten(ingredients, startPersonen)}</div>
            ` : ''}

            ${spices.length ? `
                <h2>Gewürze</h2>
                <ul>${spices.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
            ` : ''}

            ${preparation.length ? `
                <h2>Zubereitung</h2>
                <ol>${preparation.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
            ` : ''}

            ${tips.length ? `
                <h2>Tipps</h2>
                <ul>${tips.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
            ` : ''}

            ${equipment.length ? `
                <h2>Küchenausstattung</h2>
                <ul>${equipment.map(e => `<li>${escapeHtml(formatQuantity(e.quantity))} × ${escapeHtml(e.name || '')}</li>`).join('')}</ul>
            ` : ''}
        </article>
    `;

    const personenEl = root.querySelector('#personen');
    const zutatenEl = root.querySelector('#zutaten-bereich');
    const addBtn = root.querySelector('#add-cart');

    personenEl?.addEventListener('input', () => {
        const p = Math.max(1, parseInt(personenEl.value, 10) || 1);
        if (zutatenEl) zutatenEl.innerHTML = renderZutaten(ingredients, p);
    });

    addBtn?.addEventListener('click', () => {
        const p = Math.max(1, parseInt(personenEl.value, 10) || 1);
        if (cart.has(rezept.id)) {
            cart.setPersonen(rezept.id, p);
            addBtn.textContent = '✓ Aktualisiert';
        } else {
            cart.add({ id: rezept.id, titel: rezept.titel }, p);
            addBtn.textContent = '✓ Hinzugefügt';
        }
        setTimeout(() => navigate('/einkaufsliste'), 400);
    });

    root.querySelector('#delete-rezept')?.addEventListener('click', async () => {
        if (!confirm(`Rezept „${rezept.titel}" wirklich löschen?`)) return;
        try {
            await api.deleteRezept(rezept.id);
            cart.remove(rezept.id);
            navigate('/');
        } catch (err) {
            alert('Löschen fehlgeschlagen: ' + err.message);
        }
    });

    root.querySelector('#export-rezept')?.addEventListener('click', () => {
        // Daten-Blob (EN-Keys, kanonisch) — direkt re-importierbar via upload/import
        const json = JSON.stringify(rezept.daten, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = sanitizeFilename(rezept.titel || 'rezept') + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });
}

function sanitizeFilename(s) {
    // Erlaubt Buchstaben (inkl. Umlaute), Ziffern, _ - . und Leerzeichen.
    // Alles andere wird zu '_'. Begrenzt auf 80 Zeichen.
    return String(s)
        .replace(/[^a-zA-Z0-9äöüÄÖÜß_\- .]/g, '_')
        .trim()
        .slice(0, 80) || 'rezept';
}

export async function renderRezeptEdit(root, id) {
    root.innerHTML = `<p class="muted">Lade Rezept zum Bearbeiten…</p>`;
    let rezept;
    try {
        rezept = await api.getRezept(id);
    } catch (err) {
        root.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p><p><a href="." data-link>Zurück</a></p>`;
        return;
    }

    const initialJson = JSON.stringify(rezept.daten, null, 2);

    root.innerHTML = `
        <section class="rezept">
            <p><a href="rezept/${id}" data-link>← Zurück zum Rezept</a></p>
            <h1>Rezept bearbeiten</h1>
            <p class="muted">JSON direkt editieren. Keys dürfen DE oder EN sein — die werden beim Speichern automatisch normalisiert.</p>

            <textarea id="editor" spellcheck="false">${escapeHtml(initialJson)}</textarea>

            <div class="row-buttons">
                <button type="button" class="btn primary" id="save">Speichern</button>
                <button type="button" class="btn" id="reset">Zurücksetzen</button>
                <a href="rezept/${id}" data-link class="btn">Abbrechen</a>
            </div>
            <div id="edit-status"></div>
        </section>
    `;

    const editor = root.querySelector('#editor');
    const status = root.querySelector('#edit-status');

    function showStatus(msg, kind = 'info') {
        status.innerHTML = `<p class="${kind}">${escapeHtml(msg)}</p>`;
    }

    root.querySelector('#reset').addEventListener('click', () => {
        editor.value = initialJson;
        status.innerHTML = '';
    });

    root.querySelector('#save').addEventListener('click', async () => {
        let parsed;
        try {
            parsed = JSON.parse(editor.value);
        } catch (err) {
            showStatus('Ungültiges JSON: ' + err.message, 'error');
            return;
        }
        showStatus('Speichere…');
        try {
            await api.updateRezept(id, parsed);
            // Cart-Titel aktualisieren falls vorhanden
            if (cart.has(id)) {
                const title = parsed.title ?? parsed.titel;
                if (title) {
                    const entry = cart.all().find(c => c.id === id);
                    if (entry) {
                        cart.remove(id);
                        cart.add({ id, titel: title }, entry.personen);
                    }
                }
            }
            showStatus('✓ Gespeichert', 'success');
            setTimeout(() => navigate(`/rezept/${id}`), 400);
        } catch (err) {
            showStatus('Fehler: ' + err.message, 'error');
        }
    });
}

function renderZutaten(ingredients, personen) {
    const faktor = personen;
    return ingredients.map(g => {
        const items = Array.isArray(g.items) ? g.items : [];
        return `
            ${g.group ? `<h3>${escapeHtml(g.group)}</h3>` : ''}
            <ul class="zutaten">
                ${items.map(i => {
                    const q = typeof i.quantity === 'number' ? i.quantity * faktor : '';
                    const u = displayUnit(i.unit);
                    return `<li><strong>${escapeHtml(formatQuantity(q))}${u ? ' ' + escapeHtml(u) : ''}</strong> ${escapeHtml(i.name || '')}</li>`;
                }).join('')}
            </ul>
        `;
    }).join('');
}
