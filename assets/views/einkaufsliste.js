import { api } from '../api.js';
import { cart } from '../app.js';
import { displayUnit } from '../units.js';
import { renderRezeptHtml, downloadRecipesAsText, loadCartRecipes } from './rezepte_print.js';

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

function aggregateSpices(recipes) {
    const seen = new Map();
    for (const { rezept } of recipes) {
        const spices = (rezept.daten?.spices || []).filter(Boolean);
        for (const s of spices) {
            const trimmed = String(s).trim();
            if (!trimmed) continue;
            const key = trimmed.toLowerCase();
            if (!seen.has(key)) seen.set(key, trimmed);
        }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'de'));
}

function aggregateEquipment(recipes) {
    // Pro Equipment-Name den größten gefundenen Bedarf nehmen — kein Aufsummieren,
    // weil ein Topf für mehrere Rezepte typischerweise wiederverwendet wird.
    const map = new Map();
    for (const { rezept } of recipes) {
        const items = Array.isArray(rezept.daten?.kitchen_equipment)
            ? rezept.daten.kitchen_equipment : [];
        for (const e of items) {
            const name = String(e.name ?? '').trim();
            if (!name) continue;
            const qty = typeof e.quantity === 'number' && e.quantity > 0 ? e.quantity : 1;
            const key = name.toLowerCase();
            const prev = map.get(key);
            if (!prev || prev.quantity < qty) {
                map.set(key, { quantity: qty, name });
            }
        }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

function spicesToText(spices) {
    if (!spices.length) return '';
    return spices.map(s => '- ' + s).join('\n') + '\n';
}

function equipmentToText(items) {
    if (!items.length) return '';
    return items.map(e => `- ${formatQuantity(e.quantity)} × ${e.name}`).join('\n') + '\n';
}

export function renderEinkaufsliste(root) {
    let cachedRecipes = null;

    async function loadRecipes() {
        if (cachedRecipes) return cachedRecipes;
        cachedRecipes = await loadCartRecipes();
        return cachedRecipes;
    }

    function draw() {
        cachedRecipes = null;
        const items = cart.all();

        root.innerHTML = `
            <section>
                <div class="no-print">
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
                            <button type="button" class="btn primary" id="show-zutaten">Zutaten</button>
                            <button type="button" class="btn" id="show-gewuerze">Gewürze</button>
                            <button type="button" class="btn" id="show-equipment">Küchenausstattung</button>
                            <button type="button" class="btn" id="show-rezepte">Komplette Rezepte</button>
                            <button type="button" class="btn" id="clear">Alle entfernen</button>
                        </div>
                    ` : `
                        <p class="muted">Noch keine Rezepte ausgewählt. <a href="/" data-link>Rezepte ansehen</a></p>
                    `}
                </div>
                <div id="ergebnis"></div>
            </section>
        `;

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

        root.querySelector('#clear').addEventListener('click', () => {
            if (confirm('Alle Rezepte aus der Einkaufsliste entfernen?')) {
                cart.clear();
                draw();
            }
        });

        root.querySelector('#show-zutaten').addEventListener('click', generateZutaten);
        root.querySelector('#show-gewuerze').addEventListener('click', generateGewuerze);
        root.querySelector('#show-equipment').addEventListener('click', generateEquipment);
        root.querySelector('#show-rezepte').addEventListener('click', generateRezepte);
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

            const text = listToText(liste);
            ergebnis.innerHTML = `
                <div class="ergebnis">
                    <h2>Zutaten (skaliert &amp; aggregiert)</h2>
                    ${liste.map(grp => `
                        ${grp.group ? `<h3>${escapeHtml(grp.group)}</h3>` : ''}
                        <ul>
                            ${grp.items.map(it => {
                                const u = displayUnit(it.unit);
                                return `
                                <li>
                                    <label>
                                        <input type="checkbox">
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
                    </div>
                </div>
            `;

            ergebnis.querySelector('[data-action=copy]').addEventListener('click', () => copyText(text));
            ergebnis.querySelector('[data-action=download]').addEventListener('click', () => downloadText('einkaufsliste.txt', text));
        } catch (err) {
            ergebnis.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    async function generateGewuerze() {
        const ergebnis = root.querySelector('#ergebnis');
        ergebnis.innerHTML = `<p class="muted">Lade Rezepte…</p>`;
        try {
            const recipes = await loadRecipes();
            const spices = aggregateSpices(recipes);

            if (!spices.length) {
                ergebnis.innerHTML = `<p class="muted">Keine Gewürze in den ausgewählten Rezepten.</p>`;
                return;
            }

            const text = spicesToText(spices);
            ergebnis.innerHTML = `
                <div class="ergebnis">
                    <h2>Gewürze (${spices.length} verschiedene)</h2>
                    <ul>
                        ${spices.map(s => `
                            <li><label><input type="checkbox"> ${escapeHtml(s)}</label></li>
                        `).join('')}
                    </ul>
                    <div class="row-buttons">
                        <button type="button" class="btn" data-action="copy">📋 Kopieren</button>
                        <button type="button" class="btn" data-action="download">💾 Als .txt herunterladen</button>
                    </div>
                </div>
            `;

            ergebnis.querySelector('[data-action=copy]').addEventListener('click', () => copyText(text));
            ergebnis.querySelector('[data-action=download]').addEventListener('click', () => downloadText('gewuerze.txt', text));
        } catch (err) {
            ergebnis.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    async function generateEquipment() {
        const ergebnis = root.querySelector('#ergebnis');
        ergebnis.innerHTML = `<p class="muted">Lade Rezepte…</p>`;
        try {
            const recipes = await loadRecipes();
            const equipment = aggregateEquipment(recipes);

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
                        ${equipment.map(e => `
                            <li><label>
                                <input type="checkbox">
                                <strong>${escapeHtml(formatQuantity(e.quantity))} ×</strong>
                                ${escapeHtml(e.name)}
                            </label></li>
                        `).join('')}
                    </ul>
                    <div class="row-buttons">
                        <button type="button" class="btn" data-action="copy">📋 Kopieren</button>
                        <button type="button" class="btn" data-action="download">💾 Als .txt herunterladen</button>
                    </div>
                </div>
            `;

            ergebnis.querySelector('[data-action=copy]').addEventListener('click', () => copyText(text));
            ergebnis.querySelector('[data-action=download]').addEventListener('click', () => downloadText('kuechenausstattung.txt', text));
        } catch (err) {
            ergebnis.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    draw();
}
