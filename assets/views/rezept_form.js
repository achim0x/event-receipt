// Formular-basierter Rezept-Editor — wird für Bearbeiten UND Anlegen benutzt.
//
// Die DOM ist die Source of Truth: beim Speichern werden alle Felder durch
// Selektoren ausgelesen, in das kanonische Schema serialisiert und über die
// bestehenden API-Endpoints geschickt:
//   - Neues Rezept   → POST /api/upload.php (via api.uploadRezeptJson)
//   - Bestehendes Rz → PUT  /api/rezepte.php/:id (via api.updateRezept)
//
// Das Backend (normalize_recipe) macht die finale Validierung und Einheiten-
// /Department-Normalisierung — wir schicken einfach was der User eingibt.

import { api } from '../api.js';
import { navigate, cart } from '../app.js';
import { VALID_DEPARTMENTS, displayDepartment } from '../aggregate.js';
import { VALID_TAGS, displayTag } from '../tags.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// Einheiten die wir im Select anbieten. Server normalisiert: kg→g, L→ml,
// EL→g(×15), TL→g(×5), Stück/Stk→Pcs, Packung→Pck — der User darf weiterhin
// in der „natürlichen" Einheit eingeben.
const UNIT_OPTIONS = ['', 'g', 'kg', 'ml', 'L', 'EL', 'TL', 'Stück', 'Packung', 'Pcs', 'Pck'];

function unitOptionsHtml(selected) {
    return UNIT_OPTIONS.map(u => {
        const label = u === '' ? '— keine —' : u;
        const sel = u === (selected ?? '') ? ' selected' : '';
        return `<option value="${escapeHtml(u)}"${sel}>${escapeHtml(label)}</option>`;
    }).join('');
}

function departmentOptionsHtml(selected) {
    const sel = canonicalForSelect(selected);
    let html = `<option value=""${sel === '' ? ' selected' : ''}>— keine —</option>`;
    for (const slug of VALID_DEPARTMENTS) {
        const s = slug === sel ? ' selected' : '';
        html += `<option value="${escapeHtml(slug)}"${s}>${escapeHtml(displayDepartment(slug))}</option>`;
    }
    return html;
}

// Akzeptiert sowohl DE-Altdaten als auch EN-kanonisch; gibt den passenden
// Select-Value (EN-Slug) zurück — bzw. '' wenn unbekannt.
function canonicalForSelect(value) {
    const v = String(value ?? '').trim();
    if (!v) return '';
    const lower = v.toLowerCase();
    for (const slug of VALID_DEPARTMENTS) {
        if (slug.toLowerCase() === lower) return slug;
    }
    // DE-Aliase
    const de2en = {
        'obst/gemüse': 'fruit/vegetables',
        'frische theke': 'fresh-counter',
        'non-food': 'non-food',
        'getränke': 'drinks',
        'backen': 'baking',
        'grundnahrungsmittel': 'staple-foods',
    };
    return de2en[lower] ?? '';
}

function emptyRecipe() {
    return {
        title: '',
        category: '',
        source: '',
        preparation_time: '',
        tags: [],
        ingredients: [{ group: '', items: [{ quantity: '', unit: '', name: '', department: '' }] }],
        spices: [],
        preparation: [''],
        tips: [],
        kitchen_equipment: [],
    };
}

/**
 * Holt das Rezept und rendert das Formular im Bearbeiten-Modus.
 */
export async function renderRezeptFormEdit(root, id) {
    root.innerHTML = `<p class="muted">Lade Rezept zum Bearbeiten…</p>`;
    let rezept;
    try {
        rezept = await api.getRezept(id);
    } catch (err) {
        root.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p><p><a href="." data-link>Zurück</a></p>`;
        return;
    }
    renderForm(root, {
        mode: 'edit',
        id,
        data: rezept.daten || emptyRecipe(),
        backLink: `rezept/${id}`,
        title: 'Rezept bearbeiten',
    });
}

/**
 * Rendert das leere Formular zum Anlegen eines neuen Rezepts.
 */
export function renderRezeptFormNew(root) {
    renderForm(root, {
        mode: 'new',
        id: null,
        data: emptyRecipe(),
        backLink: '.',
        title: 'Neues Rezept',
    });
}

function renderForm(root, { mode, id, data, backLink, title }) {
    const isEdit = mode === 'edit';

    // Beim Bearbeiten kommt zusätzlich ein Tab-Switch zwischen Formular
    // und JSON-Editor (= existierender Editor). Beim Anlegen nicht — JSON
    // ist nur für Bestandsrezepte sinnvoll.
    const tabsHtml = isEdit ? `
        <div class="editor-tabs" role="tablist">
            <button type="button" class="editor-tab active" role="tab" data-tab="form" aria-selected="true">📝 Formular</button>
            <button type="button" class="editor-tab" role="tab" data-tab="json" aria-selected="false">{ } JSON</button>
        </div>
    ` : '';

    root.innerHTML = `
        <section class="rezept rezept-form-section">
            <p><a href="${escapeHtml(backLink)}" data-link>← Zurück</a></p>
            <h1>${escapeHtml(title)}</h1>
            ${tabsHtml}

            <form id="rezept-form" novalidate>
                ${renderGeneralFields(data)}
                ${renderTagsBlock(data.tags)}
                ${renderIngredientsBlock(data.ingredients)}
                ${renderSimpleListBlock('Gewürze', 'spices', data.spices, 'Gewürz hinzufügen', false)}
                ${renderSimpleListBlock('Zubereitung', 'preparation', data.preparation, 'Schritt hinzufügen', true)}
                ${renderSimpleListBlock('Tipps', 'tips', data.tips, 'Tipp hinzufügen', true)}
                ${renderEquipmentBlock(data.kitchen_equipment)}

                <div class="row-buttons">
                    <button type="submit" class="btn primary needs-network" id="form-save">
                        ${isEdit ? 'Speichern' : 'Rezept anlegen'}
                    </button>
                    <a href="${escapeHtml(backLink)}" data-link class="btn">Abbrechen</a>
                </div>
                <div id="form-status"></div>
            </form>
        </section>
    `;

    bindForm(root, { mode, id, isEdit, data });
}

// --- Section renderers -----------------------------------------------------

function renderGeneralFields(data) {
    return `
        <fieldset class="form-section">
            <legend>Allgemein</legend>
            <label class="field">
                <span>Titel<span class="req">*</span></span>
                <input type="text" name="title" value="${escapeHtml(data.title ?? '')}" required maxlength="200">
            </label>
            <div class="form-grid-2">
                <label class="field">
                    <span>Kategorie</span>
                    <input type="text" name="category" value="${escapeHtml(data.category ?? '')}" maxlength="100">
                </label>
                <label class="field">
                    <span>Zubereitungszeit</span>
                    <input type="text" name="preparation_time" value="${escapeHtml(data.preparation_time ?? '')}" maxlength="100" placeholder="z.B. 30 Min.">
                </label>
            </div>
            <label class="field">
                <span>Quelle</span>
                <input type="text" name="source" value="${escapeHtml(data.source ?? '')}" maxlength="200" placeholder="Kochbuch, URL, …">
            </label>
        </fieldset>
    `;
}

function renderTagsBlock(tags) {
    // Tags sind ein controlled vocabulary (vegan/vegetarian) — daher Checkboxen
    // statt Freitext. Bestandsdaten könnten DE-Werte enthalten; die Set-Logik
    // unten case-insensitive matcht auf den Slug-Lowercase.
    const active = new Set((Array.isArray(tags) ? tags : []).map(t => String(t).toLowerCase()));
    const opts = VALID_TAGS.map(slug => {
        const checked = active.has(slug.toLowerCase()) ? ' checked' : '';
        return `
            <label class="tag-check">
                <input type="checkbox" name="tag" value="${escapeHtml(slug)}"${checked}>
                <span>${escapeHtml(displayTag(slug))}</span>
            </label>
        `;
    }).join('');
    return `
        <fieldset class="form-section">
            <legend>Etiketten</legend>
            <div class="tag-checks">${opts}</div>
        </fieldset>
    `;
}

function renderIngredientsBlock(ingredients) {
    const groups = Array.isArray(ingredients) && ingredients.length
        ? ingredients
        : [{ group: '', items: [{ quantity: '', unit: '', name: '', department: '' }] }];

    const groupsHtml = groups.map(renderIngredientGroup).join('');

    return `
        <fieldset class="form-section">
            <legend>Zutaten<span class="req">*</span></legend>
            <p class="muted">Mengen pro Person. Beim Speichern werden Einheiten normalisiert (kg→g, L→ml, EL/TL→g, Stück→Pcs, Packung→Pck).</p>
            <div id="groups">${groupsHtml}</div>
            <button type="button" class="btn small" data-add="group">+ Gruppe hinzufügen</button>
        </fieldset>
    `;
}

function renderIngredientGroup(group) {
    const items = Array.isArray(group?.items) && group.items.length
        ? group.items
        : [{ quantity: '', unit: '', name: '', department: '' }];
    const itemsHtml = items.map(renderIngredientItem).join('');

    return `
        <div class="ingredient-group">
            <div class="ingredient-group-head">
                <label class="field flex-grow">
                    <span>Gruppen-Name <small class="muted">(optional, z.B. „Teig", „Soße")</small></span>
                    <input type="text" name="group_name" value="${escapeHtml(group?.group ?? '')}" maxlength="100">
                </label>
                <button type="button" class="btn small danger" data-remove="group" title="Gruppe entfernen">× Gruppe</button>
            </div>
            <div class="ingredient-items">${itemsHtml}</div>
            <button type="button" class="btn small" data-add="item">+ Zutat</button>
        </div>
    `;
}

function renderIngredientItem(item) {
    return `
        <div class="ingredient-item">
            <input type="text" class="qty" name="quantity" value="${escapeHtml(item?.quantity ?? '')}" inputmode="decimal" placeholder="Menge">
            <select class="unit" name="unit">${unitOptionsHtml(item?.unit)}</select>
            <input type="text" class="name" name="name" value="${escapeHtml(item?.name ?? '')}" placeholder="Zutat" required maxlength="200">
            <select class="dept" name="department">${departmentOptionsHtml(item?.department)}</select>
            <button type="button" class="btn small danger icon-only" data-remove="item" title="Zutat entfernen">×</button>
        </div>
    `;
}

function renderSimpleListBlock(legend, name, values, addLabel, multiline) {
    const items = Array.isArray(values) ? values.filter(v => v != null) : [];
    if (items.length === 0) items.push('');
    const itemsHtml = items.map(v => renderSimpleListRow(v, multiline)).join('');

    return `
        <fieldset class="form-section">
            <legend>${escapeHtml(legend)}</legend>
            <div class="simple-list" data-list="${escapeHtml(name)}" data-multiline="${multiline ? '1' : '0'}">${itemsHtml}</div>
            <button type="button" class="btn small" data-add="list-row" data-list-target="${escapeHtml(name)}">+ ${escapeHtml(addLabel)}</button>
        </fieldset>
    `;
}

function renderSimpleListRow(value, multiline) {
    const inputHtml = multiline
        ? `<textarea name="value" rows="2" maxlength="5000">${escapeHtml(value)}</textarea>`
        : `<input type="text" name="value" value="${escapeHtml(value)}" maxlength="2000">`;
    return `
        <div class="simple-list-row">
            ${inputHtml}
            <button type="button" class="btn small danger icon-only" data-remove="list-row" title="Zeile entfernen">×</button>
        </div>
    `;
}

function renderEquipmentBlock(equipment) {
    const items = Array.isArray(equipment) ? equipment : [];
    const itemsHtml = items.map(renderEquipmentRow).join('') || renderEquipmentRow({ quantity: '', name: '' });

    return `
        <fieldset class="form-section">
            <legend>Küchenausstattung</legend>
            <div id="equipment-list">${itemsHtml}</div>
            <button type="button" class="btn small" data-add="equipment">+ Gerät</button>
        </fieldset>
    `;
}

function renderEquipmentRow(eq) {
    return `
        <div class="equipment-row">
            <input type="text" class="qty" name="eq_quantity" value="${escapeHtml(eq?.quantity ?? '')}" inputmode="numeric" placeholder="Anzahl">
            <input type="text" class="name" name="eq_name" value="${escapeHtml(eq?.name ?? '')}" placeholder="Gerät" maxlength="200">
            <button type="button" class="btn small danger icon-only" data-remove="equipment" title="Gerät entfernen">×</button>
        </div>
    `;
}

// --- Event binding ---------------------------------------------------------

function bindForm(root, { mode, id, isEdit }) {
    const form = root.querySelector('#rezept-form');
    const status = root.querySelector('#form-status');

    // Tab-Switch (nur edit) — wechselt zwischen Form und JSON-View on demand.
    if (isEdit) {
        root.querySelectorAll('.editor-tab').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tab = btn.dataset.tab;
                if (tab === 'json') {
                    // Lazy import damit das Formular nicht den JSON-Editor mitlädt
                    const { renderRezeptEditJson } = await import('./rezepte.js');
                    renderRezeptEditJson(root, id);
                }
            });
        });
    }

    // Delegated Click-Handler für Add/Remove
    form.addEventListener('click', (e) => {
        const t = e.target.closest('button');
        if (!t) return;

        const add = t.dataset.add;
        if (add === 'group') {
            const groups = form.querySelector('#groups');
            groups.insertAdjacentHTML('beforeend', renderIngredientGroup({ group: '', items: [{}] }));
            return;
        }
        if (add === 'item') {
            const group = t.closest('.ingredient-group');
            group.querySelector('.ingredient-items').insertAdjacentHTML('beforeend', renderIngredientItem({}));
            return;
        }
        if (add === 'list-row') {
            const targetName = t.dataset.listTarget;
            const list = form.querySelector(`.simple-list[data-list="${CSS.escape(targetName)}"]`);
            const multiline = list.dataset.multiline === '1';
            list.insertAdjacentHTML('beforeend', renderSimpleListRow('', multiline));
            return;
        }
        if (add === 'equipment') {
            form.querySelector('#equipment-list').insertAdjacentHTML('beforeend', renderEquipmentRow({}));
            return;
        }

        const remove = t.dataset.remove;
        if (remove === 'group') {
            const groups = form.querySelectorAll('.ingredient-group');
            if (groups.length <= 1) {
                // Letzte Gruppe nicht entfernen — Items darin clearen statt löschen
                const onlyGroup = groups[0];
                onlyGroup.querySelector('input[name="group_name"]').value = '';
                onlyGroup.querySelector('.ingredient-items').innerHTML = renderIngredientItem({});
            } else {
                t.closest('.ingredient-group').remove();
            }
            return;
        }
        if (remove === 'item') {
            const group = t.closest('.ingredient-group');
            const items = group.querySelectorAll('.ingredient-item');
            if (items.length <= 1) {
                // Last item: clear instead of remove
                const it = items[0];
                it.querySelector('.qty').value = '';
                it.querySelector('.unit').value = '';
                it.querySelector('.name').value = '';
                it.querySelector('.dept').value = '';
            } else {
                t.closest('.ingredient-item').remove();
            }
            return;
        }
        if (remove === 'list-row') {
            t.closest('.simple-list-row').remove();
            return;
        }
        if (remove === 'equipment') {
            t.closest('.equipment-row').remove();
            return;
        }
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = serializeForm(form);

        if (!payload.title) {
            showStatus(status, 'Titel ist Pflicht.', 'error');
            form.querySelector('input[name="title"]')?.focus();
            return;
        }
        if (!payload.ingredients.length) {
            showStatus(status, 'Mindestens eine Zutat erforderlich.', 'error');
            return;
        }

        showStatus(status, 'Speichere…');
        try {
            if (isEdit) {
                await api.updateRezept(id, payload);
                // Cart-Titel evtl. updaten
                if (cart.has(id)) {
                    const entry = cart.all().find(c => c.id === id);
                    if (entry && entry.titel !== payload.title) {
                        cart.remove(id);
                        cart.add({ id, titel: payload.title }, entry.personen);
                    }
                }
                showStatus(status, '✓ Gespeichert', 'success');
                setTimeout(() => navigate(`/rezept/${id}`), 400);
            } else {
                const result = await api.uploadRezeptJson(payload);
                showStatus(status, `✓ Gespeichert (ID ${result.id})`, 'success');
                setTimeout(() => navigate(`/rezept/${result.id}`), 400);
            }
        } catch (err) {
            showStatus(status, 'Fehler: ' + err.message, 'error');
        }
    });
}

function showStatus(el, msg, kind = 'info') {
    el.innerHTML = `<p class="${kind}">${escapeHtml(msg)}</p>`;
}

// --- Serialization ---------------------------------------------------------

function trimOrNull(s) {
    const v = String(s ?? '').trim();
    return v === '' ? null : v;
}

function parseQuantity(raw) {
    const v = String(raw ?? '').trim().replace(',', '.');
    if (v === '') return 0;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

function serializeForm(form) {
    const out = {};
    out.title = (form.querySelector('input[name="title"]')?.value ?? '').trim();

    for (const f of ['category', 'source', 'preparation_time']) {
        const v = trimOrNull(form.querySelector(`input[name="${f}"]`)?.value);
        if (v !== null) out[f] = v;
    }

    // Tags: Checkbox-Values einsammeln (sind bereits englische Slugs)
    const tags = [];
    form.querySelectorAll('input[name="tag"]:checked').forEach(el => {
        tags.push(el.value);
    });
    out.tags = tags;

    // Ingredients
    const groups = [];
    form.querySelectorAll('.ingredient-group').forEach(groupEl => {
        const groupName = (groupEl.querySelector('input[name="group_name"]')?.value || '').trim();
        const items = [];
        groupEl.querySelectorAll('.ingredient-item').forEach(itemEl => {
            const name = (itemEl.querySelector('input.name')?.value || '').trim();
            if (!name) return;  // ohne Name kein Item
            const item = {
                quantity: parseQuantity(itemEl.querySelector('input.qty')?.value),
                unit: (itemEl.querySelector('select.unit')?.value || '').trim(),
                name,
            };
            const dept = (itemEl.querySelector('select.dept')?.value || '').trim();
            if (dept) item.department = dept;
            items.push(item);
        });
        if (items.length > 0) {
            const g = { items };
            if (groupName) g.group = groupName;
            groups.push(g);
        }
    });
    out.ingredients = groups;

    // Simple lists
    for (const name of ['spices', 'preparation', 'tips']) {
        const list = form.querySelector(`.simple-list[data-list="${CSS.escape(name)}"]`);
        if (!list) { out[name] = []; continue; }
        const values = [];
        list.querySelectorAll('.simple-list-row').forEach(row => {
            const inp = row.querySelector('[name="value"]');
            const v = (inp?.value || '').trim();
            if (v) values.push(v);
        });
        out[name] = values;
    }

    // Equipment
    const equipment = [];
    form.querySelectorAll('.equipment-row').forEach(row => {
        const name = (row.querySelector('input.name')?.value || '').trim();
        if (!name) return;
        const qty = parseQuantity(row.querySelector('input.qty')?.value) || 1;
        equipment.push({ quantity: qty, name });
    });
    out.kitchen_equipment = equipment;

    return out;
}
