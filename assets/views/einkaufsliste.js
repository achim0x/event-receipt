import { api } from '../api.js';
import { cart } from '../app.js';
import { displayUnit } from '../units.js';
import { renderRezeptHtml, downloadRecipesAsText, loadCartRecipes } from './rezepte_print.js';
import { aggregateIngredients, aggregateSpices, aggregateEquipment } from '../aggregate.js';

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

function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        alert('In Zwischenablage kopiert.');
    } catch {
        alert('Kopieren fehlgeschlagen — bitte manuell aus der Liste kopieren.');
    }
}

function listToText(liste) {
    const lines = [];
    for (const grp of liste) {
        if (grp.group) lines.push(`# ${grp.group}`);
        for (const it of grp.items) {
            const q = formatQuantity(it.quantity);
            const u = displayUnit(it.unit);
            const parts = [q, u, it.name].filter(Boolean);
            lines.push('- ' + parts.join(' '));
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd() + '\n';
}

function spicesToText(spices) {
    if (!spices.length) return '';
    return spices.map(s => '- ' + s).join('\n') + '\n';
}

function equipmentToText(items) {
    if (!items.length) return '';
    return items.map(e => `- ${formatQuantity(e.quantity)} × ${e.name}`).join('\n') + '\n';
}

// Schlüssel zum Matchen abgehakter Einträge gegen die DB. Wert wird auch
// in `data-schluessel` der Checkboxen geschrieben, damit der Toggle-
// Handler weiß was er an den Server schickt.
function checkKey(name, unit = '') {
    return `${String(name ?? '').trim().toLowerCase()}||${String(unit ?? '').trim().toLowerCase()}`;
}

/**
 * Hängt ein Set von checked-keys (z.B. ['mehl||g']) an einen Container
 * mit `<input type="checkbox" data-kategorie="..." data-schluessel="...">`
 * Elementen — setzt initial checked und verdrahtet den Toggle-Handler.
 */
function wireCheckboxes(container, checkedSet) {
    container.querySelectorAll('input[type=checkbox][data-schluessel]').forEach(cb => {
        const kategorie = cb.dataset.kategorie;
        const schluessel = cb.dataset.schluessel;
        if (checkedSet.has(schluessel)) cb.checked = true;

        cb.addEventListener('change', async () => {
            try {
                await api.setCheck(kategorie, schluessel, cb.checked);
            } catch (err) {
                console.error('Check-Sync zum Server fehlgeschlagen:', err);
            }
        });
    });
}

export async function renderEinkaufsliste(root) {
    let cachedRecipes = null;
    let savedLists = [];

    root.innerHTML = `<p class="muted">Lade Einkaufsliste…</p>`;

    // Server-State frisch holen — sonst sieht man Änderungen anderer User nicht
    await cart.refresh();
    await refreshSavedLists();

    // Offline-tolerantes Holen der abgehakt-Marker: wenn der Endpunkt
    // nicht im Service-Worker-Cache ist und gerade kein Netz da → still
    // mit leerem Set zurück, damit die Aggregations-View weiter funktioniert.
    // Echte Server-Fehler werden geloggt aber nicht eskaliert.
    async function safeGetChecks() {
        try {
            return await api.getChecks();
        } catch (err) {
            console.warn('Checks nicht ladbar (vermutlich offline):', err);
            return { zutaten: [], gewuerze: [], equipment: [] };
        }
    }

    async function refreshSavedLists() {
        try {
            const data = await api.listSavedLists();
            savedLists = Array.isArray(data.listen) ? data.listen : [];
        } catch (err) {
            console.error('Saved lists laden fehlgeschlagen:', err);
            savedLists = [];
        }
    }

    async function loadRecipes() {
        if (cachedRecipes) return cachedRecipes;
        cachedRecipes = await loadCartRecipes();
        return cachedRecipes;
    }

    function renderSavedListsTable() {
        if (!savedLists.length) {
            return `<p class="muted">Noch keine Listen gespeichert.</p>`;
        }
        return `
            <table class="cart-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Inhalt</th>
                        <th>Gespeichert</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${savedLists.map(l => `
                        <tr data-name="${escapeHtml(l.name)}">
                            <td><strong>${escapeHtml(l.name)}</strong></td>
                            <td>${l.count} Rezept${l.count === 1 ? '' : 'e'}</td>
                            <td class="muted small">${escapeHtml(l.gespeichert_am)}</td>
                            <td>
                                <button type="button" class="btn small load-list needs-network">📂 Laden</button>
                                <button type="button" class="btn small danger del-list needs-network">🗑</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    function draw() {
        cachedRecipes = null;
        const items = cart.all();
        const snapshot = cart.snapshot();
        const snapshotCount = snapshot ? Object.keys(snapshot).length : 0;

        const snapshotBanner = snapshotCount > 0
            ? `<div class="snapshot-banner">📸 <strong>Snapshot-Modus</strong>: ${snapshotCount} Rezept${snapshotCount === 1 ? ' ist' : 'e sind'} eingefroren — spätere Änderungen am Original wirken sich auf diese Liste nicht aus. <button type="button" class="btn small" id="exit-snapshot">Snapshot verwerfen</button></div>`
            : '';

        root.innerHTML = `
            <section>
                <div class="no-print">
                    <h1>Einkaufsliste</h1>
                    ${snapshotBanner}

                    <details class="saved-lists-section" ${savedLists.length ? 'open' : ''}>
                        <summary>Gespeicherte Listen (${savedLists.length})</summary>
                        <div class="saved-lists-body">
                            ${renderSavedListsTable()}
                        </div>
                    </details>

                    ${items.length ? `
                        <h2>Aktuelle Auswahl</h2>
                        <table class="cart-table">
                            <thead><tr><th>Rezept</th><th>Personen</th><th></th></tr></thead>
                            <tbody>
                                ${items.map(r => `
                                    <tr data-id="${r.id}">
                                        <td><a href="rezept/${r.id}" data-link>${escapeHtml(r.titel)}</a></td>
                                        <td><input type="number" min="1" max="999" value="${r.personen}" class="personen-input"></td>
                                        <td><button type="button" class="btn small remove">Entfernen</button></td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                        <div class="save-as-row">
                            <label class="save-as-label">Aktuelle Auswahl speichern als:
                                <input type="text" id="save-name" maxlength="80" placeholder="z.B. Wochenplan KW18">
                            </label>
                            <button type="button" class="btn needs-network" id="save-as">💾 Speichern</button>
                        </div>
                        <div class="row-buttons">
                            <button type="button" class="btn primary" id="show-zutaten">Zutaten</button>
                            <button type="button" class="btn" id="show-gewuerze">Gewürze</button>
                            <button type="button" class="btn" id="show-equipment">Küchenausstattung</button>
                            <button type="button" class="btn" id="show-rezepte">Komplette Rezepte</button>
                            <button type="button" class="btn" id="clear">Alle entfernen</button>
                        </div>
                    ` : `
                        <p class="muted">Noch keine Rezepte ausgewählt. <a href="." data-link>Rezepte ansehen</a></p>
                    `}
                </div>
                <div id="ergebnis"></div>
            </section>
        `;

        // Saved-Lists Row-Handlers (auch wenn aktuelle Auswahl leer ist)
        root.querySelectorAll('tr[data-name]').forEach(tr => {
            const name = tr.dataset.name;
            tr.querySelector('.load-list').addEventListener('click', () => loadSavedList(name));
            tr.querySelector('.del-list').addEventListener('click', () => deleteSavedList(name));
        });

        const exitSnapshotBtn = root.querySelector('#exit-snapshot');
        if (exitSnapshotBtn) {
            exitSnapshotBtn.addEventListener('click', () => {
                if (!confirm('Snapshot verwerfen? Die Liste nutzt danach wieder die aktuellen Rezeptdaten.')) return;
                // Items behalten, nur Snapshot leeren
                cart.replaceAll(cart.all(), {});
                draw();
            });
        }

        if (!items.length) return;

        root.querySelectorAll('tr[data-id]').forEach(tr => {
            const id = parseInt(tr.dataset.id, 10);
            tr.querySelector('.personen-input').addEventListener('change', (e) => {
                cart.setPersonen(id, e.target.value);
                cachedRecipes = null;
            });
            tr.querySelector('.remove').addEventListener('click', () => {
                cart.remove(id);
                draw();
            });
        });

        root.querySelector('#clear').addEventListener('click', async () => {
            if (!confirm('Alle Rezepte aus der Einkaufsliste entfernen?')) return;
            cart.clear();
            try { await api.clearChecks(); } catch (err) { console.error('clearChecks failed:', err); }
            draw();
        });

        const saveBtn = root.querySelector('#save-as');
        const saveInput = root.querySelector('#save-name');
        async function doSaveAs() {
            const name = saveInput.value.trim();
            if (!name) {
                alert('Bitte einen Namen eingeben.');
                saveInput.focus();
                return;
            }
            const exists = savedLists.some(l => l.name.toLowerCase() === name.toLowerCase());
            if (exists && !confirm(`Eine Liste mit dem Namen "${name}" existiert bereits. Überschreiben?`)) {
                return;
            }
            try {
                await api.saveCartAs(name, cart.all());
                saveInput.value = '';
                await refreshSavedLists();
                draw();
            } catch (err) {
                alert('Speichern fehlgeschlagen: ' + err.message);
            }
        }
        saveBtn.addEventListener('click', doSaveAs);
        saveInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSaveAs(); } });

        root.querySelector('#show-zutaten').addEventListener('click', generateZutaten);
        root.querySelector('#show-gewuerze').addEventListener('click', generateGewuerze);
        root.querySelector('#show-equipment').addEventListener('click', generateEquipment);
        root.querySelector('#show-rezepte').addEventListener('click', generateRezepte);
    }

    async function loadSavedList(name) {
        if (cart.all().length > 0 &&
            !confirm(`Die aktuelle Auswahl wird durch "${name}" ersetzt. Fortfahren?`)) {
            return;
        }
        try {
            const data = await api.getSavedList(name);
            // Snapshot mitnehmen — gespeicherte Liste ist eingefroren
            cart.replaceAll(data.items || [], data.snapshot || {});
            // Neue Liste = neuer Einkaufszyklus → Häkchen zurücksetzen
            try { await api.clearChecks(); } catch (err) { console.error('clearChecks failed:', err); }
            draw();
        } catch (err) {
            alert('Laden fehlgeschlagen: ' + err.message);
        }
    }

    async function deleteSavedList(name) {
        if (!confirm(`Gespeicherte Liste "${name}" löschen?`)) return;
        try {
            await api.deleteSavedList(name);
            await refreshSavedLists();
            draw();
        } catch (err) {
            alert('Löschen fehlgeschlagen: ' + err.message);
        }
    }

    async function generateRezepte() {
        const ergebnis = root.querySelector('#ergebnis');
        ergebnis.innerHTML = `<p class="muted">Lade Rezepte…</p>`;
        try {
            const recipes = await loadRecipes();
            if (!recipes.length) {
                ergebnis.innerHTML = `<p class="muted">Keine Rezepte ausgewählt.</p>`;
                return;
            }

            ergebnis.innerHTML = `
                <div class="ergebnis print-section">
                    <div class="no-print">
                        <h2>Komplette Rezepte (${recipes.length})</h2>
                        <div class="row-buttons">
                            <button type="button" class="btn primary" data-action="print">🖨 Drucken / als PDF speichern</button>
                            <button type="button" class="btn" data-action="text">💾 Als .txt herunterladen</button>
                        </div>
                    </div>
                    <div id="recipes-print">
                        ${recipes.map(renderRezeptHtml).join('')}
                    </div>
                </div>
            `;

            ergebnis.querySelector('[data-action=print]').addEventListener('click', () => window.print());
            ergebnis.querySelector('[data-action=text]').addEventListener('click', () => downloadRecipesAsText(recipes));
        } catch (err) {
            ergebnis.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    async function generateZutaten() {
        const ergebnis = root.querySelector('#ergebnis');
        ergebnis.innerHTML = `<p class="muted">Generiere…</p>`;
        try {
            // Aggregation passiert client-seitig — bei aktivem Snapshot ohne
            // jeglichen API-Call, sonst nur die per-Rezept-GETs via
            // loadCartRecipes() (im Browser cache-fähig für Offline-Modus).
            const [recipes, checks] = await Promise.all([
                loadRecipes(),
                safeGetChecks(),
            ]);
            const { liste } = aggregateIngredients(recipes);
            const checkedSet = new Set(checks.zutaten || []);

            if (!liste.length) {
                ergebnis.innerHTML = `<p class="muted">Keine Zutaten gefunden.</p>`;
                return;
            }

            const text = listToText(liste);
            ergebnis.innerHTML = `
                <div class="ergebnis">
                    <h2>Zutaten (skaliert &amp; aggregiert)</h2>
                    ${liste.map(grp => `
                        ${grp.group ? `<h3>${escapeHtml(grp.group)}</h3>` : ''}
                        <ul>
                            ${grp.items.map(it => {
                                const u = displayUnit(it.unit);
                                const key = checkKey(it.name, it.unit);
                                return `
                                <li>
                                    <label>
                                        <input type="checkbox" data-kategorie="zutaten" data-schluessel="${escapeHtml(key)}">
                                        <strong>${escapeHtml(formatQuantity(it.quantity))}${u ? ' ' + escapeHtml(u) : ''}</strong>
                                        ${escapeHtml(it.name)}
                                    </label>
                                </li>`;
                            }).join('')}
                        </ul>
                    `).join('')}
                    <div class="row-buttons">
                        <button type="button" class="btn" data-action="copy">📋 Als Text kopieren</button>
                        <button type="button" class="btn" data-action="download">💾 Als .txt herunterladen</button>
                        <button type="button" class="btn needs-network" data-action="reset-checks">↺ Häkchen zurücksetzen</button>
                    </div>
                </div>
            `;

            wireCheckboxes(ergebnis, checkedSet);
            ergebnis.querySelector('[data-action=copy]').addEventListener('click', () => copyText(text));
            ergebnis.querySelector('[data-action=download]').addEventListener('click', () => downloadText('einkaufsliste.txt', text));
            ergebnis.querySelector('[data-action=reset-checks]').addEventListener('click', () => resetChecksFor('zutaten', generateZutaten));
        } catch (err) {
            ergebnis.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    async function generateGewuerze() {
        const ergebnis = root.querySelector('#ergebnis');
        ergebnis.innerHTML = `<p class="muted">Lade Rezepte…</p>`;
        try {
            const [recipes, checks] = await Promise.all([loadRecipes(), safeGetChecks()]);
            const spices = aggregateSpices(recipes);
            const checkedSet = new Set(checks.gewuerze || []);

            if (!spices.length) {
                ergebnis.innerHTML = `<p class="muted">Keine Gewürze in den ausgewählten Rezepten.</p>`;
                return;
            }

            const text = spicesToText(spices);
            ergebnis.innerHTML = `
                <div class="ergebnis">
                    <h2>Gewürze (${spices.length} verschiedene)</h2>
                    <ul>
                        ${spices.map(s => {
                            const key = checkKey(s);
                            return `<li><label><input type="checkbox" data-kategorie="gewuerze" data-schluessel="${escapeHtml(key)}"> ${escapeHtml(s)}</label></li>`;
                        }).join('')}
                    </ul>
                    <div class="row-buttons">
                        <button type="button" class="btn" data-action="copy">📋 Kopieren</button>
                        <button type="button" class="btn" data-action="download">💾 Als .txt herunterladen</button>
                        <button type="button" class="btn needs-network" data-action="reset-checks">↺ Häkchen zurücksetzen</button>
                    </div>
                </div>
            `;

            wireCheckboxes(ergebnis, checkedSet);
            ergebnis.querySelector('[data-action=copy]').addEventListener('click', () => copyText(text));
            ergebnis.querySelector('[data-action=download]').addEventListener('click', () => downloadText('gewuerze.txt', text));
            ergebnis.querySelector('[data-action=reset-checks]').addEventListener('click', () => resetChecksFor('gewuerze', generateGewuerze));
        } catch (err) {
            ergebnis.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    async function generateEquipment() {
        const ergebnis = root.querySelector('#ergebnis');
        ergebnis.innerHTML = `<p class="muted">Lade Rezepte…</p>`;
        try {
            const [recipes, checks] = await Promise.all([loadRecipes(), safeGetChecks()]);
            const equipment = aggregateEquipment(recipes);
            const checkedSet = new Set(checks.equipment || []);

            if (!equipment.length) {
                ergebnis.innerHTML = `<p class="muted">Keine Küchenausstattung in den ausgewählten Rezepten angegeben.</p>`;
                return;
            }

            const text = equipmentToText(equipment);
            ergebnis.innerHTML = `
                <div class="ergebnis">
                    <h2>Küchenausstattung (${equipment.length} Posten)</h2>
                    <p class="muted">Pro Posten der größte Bedarf aus den ausgewählten Rezepten — wird nicht aufsummiert, da Geräte typischerweise wiederverwendet werden.</p>
                    <ul>
                        ${equipment.map(e => {
                            const key = checkKey(e.name);
                            return `<li><label>
                                <input type="checkbox" data-kategorie="equipment" data-schluessel="${escapeHtml(key)}">
                                <strong>${escapeHtml(formatQuantity(e.quantity))} ×</strong>
                                ${escapeHtml(e.name)}
                            </label></li>`;
                        }).join('')}
                    </ul>
                    <div class="row-buttons">
                        <button type="button" class="btn" data-action="copy">📋 Kopieren</button>
                        <button type="button" class="btn" data-action="download">💾 Als .txt herunterladen</button>
                        <button type="button" class="btn needs-network" data-action="reset-checks">↺ Häkchen zurücksetzen</button>
                    </div>
                </div>
            `;

            wireCheckboxes(ergebnis, checkedSet);
            ergebnis.querySelector('[data-action=copy]').addEventListener('click', () => copyText(text));
            ergebnis.querySelector('[data-action=download]').addEventListener('click', () => downloadText('kuechenausstattung.txt', text));
            ergebnis.querySelector('[data-action=reset-checks]').addEventListener('click', () => resetChecksFor('equipment', generateEquipment));
        } catch (err) {
            ergebnis.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    /** Server-seitig alle Häkchen einer Kategorie löschen und View neu rendern */
    async function resetChecksFor(kategorie, regenerate) {
        try {
            await api.clearChecks(kategorie);
            await regenerate();
        } catch (err) {
            alert('Häkchen zurücksetzen fehlgeschlagen: ' + err.message);
        }
    }

    draw();
}
