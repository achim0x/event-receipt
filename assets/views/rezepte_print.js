import { api } from '../api.js';
import { cart } from '../app.js';
import { displayUnit } from '../units.js';

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

export function recipesToText(recipes) {
    const lines = [];
    for (const { rezept, personen } of recipes) {
        const daten = rezept.daten || {};
        const headline = `${rezept.titel}${personen > 1 ? ` (für ${personen} Personen)` : ''}`;
        lines.push('='.repeat(64));
        lines.push(headline);
        lines.push('='.repeat(64));
        if (rezept.kategorie) lines.push(`Kategorie: ${rezept.kategorie}`);
        if (rezept.zubereitungszeit) lines.push(`Zubereitungszeit: ${rezept.zubereitungszeit}`);
        if (rezept.quelle) lines.push(`Quelle: ${rezept.quelle}`);
        lines.push('');

        const groups = Array.isArray(daten.ingredients) ? daten.ingredients : [];
        if (groups.length) {
            lines.push('ZUTATEN');
            lines.push('-'.repeat(64));
            for (const g of groups) {
                if (g.group) lines.push(`[${g.group}]`);
                for (const it of (g.items || [])) {
                    const qty = typeof it.quantity === 'number' ? it.quantity * personen : '';
                    const u = displayUnit(it.unit);
                    const parts = [formatQuantity(qty), u, it.name].filter(Boolean);
                    lines.push('  - ' + parts.join(' '));
                }
            }
            lines.push('');
        }

        const spices = (daten.spices || []).filter(Boolean);
        if (spices.length) {
            lines.push('GEWÜRZE');
            lines.push('-'.repeat(64));
            for (const s of spices) lines.push('  - ' + s);
            lines.push('');
        }

        const prep = (daten.preparation || []).filter(Boolean);
        if (prep.length) {
            lines.push('ZUBEREITUNG');
            lines.push('-'.repeat(64));
            prep.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
            lines.push('');
        }

        const tips = (daten.tips || []).filter(Boolean);
        if (tips.length) {
            lines.push('TIPPS');
            lines.push('-'.repeat(64));
            for (const t of tips) lines.push('  - ' + t);
            lines.push('');
        }

        const equipment = Array.isArray(daten.kitchen_equipment) ? daten.kitchen_equipment : [];
        if (equipment.length) {
            lines.push('KÜCHENAUSSTATTUNG');
            lines.push('-'.repeat(64));
            for (const e of equipment) {
                const qty = formatQuantity(e.quantity);
                lines.push(`  - ${qty ? qty + ' × ' : ''}${e.name || ''}`);
            }
            lines.push('');
        }

        lines.push('');
    }
    return lines.join('\n').trimEnd() + '\n';
}

export function renderRezeptHtml({ rezept, personen }) {
    const daten = rezept.daten || {};
    const groups = Array.isArray(daten.ingredients) ? daten.ingredients : [];
    const spices = (daten.spices || []).filter(Boolean);
    const prep = (daten.preparation || []).filter(Boolean);
    const tips = (daten.tips || []).filter(Boolean);
    const equipment = Array.isArray(daten.kitchen_equipment) ? daten.kitchen_equipment : [];

    return `
        <article class="print-rezept">
            <h2>${escapeHtml(rezept.titel)}${personen > 1 ? ` <span class="muted">(für ${personen} Personen)</span>` : ''}</h2>
            <div class="meta">
                ${rezept.kategorie ? `<span class="tag">${escapeHtml(rezept.kategorie)}</span>` : ''}
                ${rezept.zubereitungszeit ? `<span>⏱ ${escapeHtml(rezept.zubereitungszeit)}</span>` : ''}
                ${rezept.quelle ? `<span>📖 ${escapeHtml(rezept.quelle)}</span>` : ''}
            </div>

            ${groups.length ? `
                <h3>Zutaten</h3>
                ${groups.map(g => `
                    ${g.group ? `<h4>${escapeHtml(g.group)}</h4>` : ''}
                    <ul class="zutaten">
                        ${(g.items || []).map(it => {
                            const qty = typeof it.quantity === 'number' ? it.quantity * personen : '';
                            const u = displayUnit(it.unit);
                            return `<li><strong>${escapeHtml(formatQuantity(qty))}${u ? ' ' + escapeHtml(u) : ''}</strong> ${escapeHtml(it.name || '')}</li>`;
                        }).join('')}
                    </ul>
                `).join('')}
            ` : ''}

            ${spices.length ? `
                <h3>Gewürze</h3>
                <ul>${spices.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
            ` : ''}

            ${prep.length ? `
                <h3>Zubereitung</h3>
                <ol>${prep.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
            ` : ''}

            ${tips.length ? `
                <h3>Tipps</h3>
                <ul>${tips.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
            ` : ''}

            ${equipment.length ? `
                <h3>Küchenausstattung</h3>
                <ul>${equipment.map(e => `<li>${escapeHtml(formatQuantity(e.quantity))}${e.name ? ' × ' + escapeHtml(e.name) : ''}</li>`).join('')}</ul>
            ` : ''}
        </article>
    `;
}

export async function loadCartRecipes() {
    const cartItems = cart.all();
    const fetched = await Promise.all(cartItems.map(c => api.getRezept(c.id)));
    return fetched.map((rezept, i) => ({ rezept, personen: cartItems[i].personen }));
}

export function downloadRecipesAsText(recipes, filename = 'rezepte.txt') {
    const text = recipesToText(recipes);
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

export async function renderRezeptePrint(root) {
    const cartItems = cart.all();
    if (!cartItems.length) {
        root.innerHTML = `
            <section>
                <p class="muted">Keine Rezepte ausgewählt. <a href="einkaufsliste" data-link>Zurück zur Einkaufsliste</a></p>
            </section>`;
        return;
    }

    root.innerHTML = `<p class="muted">Lade ${cartItems.length} Rezept(e)…</p>`;

    let recipes;
    try {
        recipes = await loadCartRecipes();
    } catch (err) {
        root.innerHTML = `<p class="error">Fehler beim Laden: ${escapeHtml(err.message)}</p>
            <p><a href="einkaufsliste" data-link>Zurück</a></p>`;
        return;
    }

    root.innerHTML = `
        <section class="print-section">
            <div class="no-print row-buttons">
                <a href="einkaufsliste" data-link class="btn">← Zurück</a>
                <button type="button" class="btn primary" id="do-print">🖨 Drucken / als PDF speichern</button>
                <button type="button" class="btn" id="do-text">💾 Als .txt herunterladen</button>
            </div>
            <h1 class="print-title">Rezeptsammlung (${recipes.length} Rezepte)</h1>
            <div id="recipes">
                ${recipes.map(renderRezeptHtml).join('')}
            </div>
        </section>
    `;

    root.querySelector('#do-print').addEventListener('click', () => window.print());
    root.querySelector('#do-text').addEventListener('click', () => downloadRecipesAsText(recipes));
}
