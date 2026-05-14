// Client-seitige Aggregation für die Einkaufsliste.
//
// Portiert die Logik aus `api/einkaufsliste.php` und die client-seitigen
// Spices/Equipment-Aggregationen aus `views/einkaufsliste.js` an eine zentrale
// Stelle. Wird sowohl für den normalen Online-Betrieb genutzt (Snapshot-
// basierte Aggregation ohne Server-Roundtrip) als auch für den offline-fähigen
// Cache-Modus, wo wir keine /api/einkaufsliste.php-Anfrage absetzen können.
//
// Eingabe einheitlich: `recipes = [{ rezept, personen }]` — passt zu dem
// was `loadCartRecipes()` aus `views/rezepte_print.js` liefert.

// Kanonische Reihenfolge wie in `valid_departments()` in api/translation.php.
// Werte sind englische Slugs (ab Mai 2026) — Display-Übersetzung weiter unten.
export const VALID_DEPARTMENTS = [
    'fruit/vegetables',
    'fresh-counter',
    'non-food',
    'drinks',
    'baking',
    'staple-foods',
];

const SONSTIGES = 'other';

// DE→EN-Mapping. Bestandsdaten und händisch geschriebene JSON-Files können
// noch deutsche Werte enthalten — `canonicalizeDepartment` glättet beim
// Aggregieren, damit alte und neue Items im selben Bucket landen.
const DEPARTMENT_DE_TO_EN = {
    'Obst/Gemüse': 'fruit/vegetables',
    'Frische Theke': 'fresh-counter',
    'Non-Food': 'non-food',
    'Getränke': 'drinks',
    'Backen': 'baking',
    'Grundnahrungsmittel': 'staple-foods',
};

// Reverse-Map plus Spezial-Wert für „Sonstiges".
const DEPARTMENT_EN_TO_DE = {
    'fruit/vegetables': 'Obst/Gemüse',
    'fresh-counter':    'Frische Theke',
    'non-food':         'Non-Food',
    'drinks':           'Getränke',
    'baking':           'Backen',
    'staple-foods':     'Grundnahrungsmittel',
    'other':            'Sonstiges',
};

/**
 * Akzeptiert deutsche oder englische Schreibweise (case-insensitiv).
 * Liefert immer den englischen kanonischen Slug zurück. Leerer Input → ''.
 * Unbekannte Werte → '' (= Sonstiges-Fallback bei der Aggregation).
 */
export function canonicalizeDepartment(value) {
    const v = String(value ?? '').trim();
    if (v === '') return '';
    const lower = v.toLowerCase();

    // Englisch direkt
    for (const en of VALID_DEPARTMENTS) {
        if (en.toLowerCase() === lower) return en;
    }
    // Deutsch
    for (const [de, en] of Object.entries(DEPARTMENT_DE_TO_EN)) {
        if (de.toLowerCase() === lower) return en;
    }
    return '';
}

/**
 * Übersetzt einen englischen Department-Slug zurück ins Deutsche für die
 * Anzeige. Unbekannter Slug → unverändert zurück (defensiv).
 */
export function displayDepartment(slug) {
    if (!slug) return '';
    return DEPARTMENT_EN_TO_DE[slug] ?? slug;
}

// Basis-Personenzahl auf die Mengen im Rezept normiert sind.
// Spiegelt `BASIS_PERSONEN` in api/einkaufsliste.php.
const BASIS_PERSONEN = 1;

function roundQty(q) {
    // Mirror der PHP-Logik: ganze Zahl wenn nah dran, sonst auf 2 Nachkommastellen.
    if (Math.abs(q - Math.round(q)) < 0.001) return Math.round(q);
    return Math.round(q * 100) / 100;
}

function lower(s) {
    return String(s ?? '').trim().toLowerCase();
}

/**
 * Aggregiert alle Zutaten aus mehreren Rezepten — analog zu einkaufsliste.php.
 *
 * - Match-Key ist `name + unit` (case-insensitiv) — die Rezept-interne `group`
 *   wird ignoriert (Kochstruktur, nicht einkaufsrelevant).
 * - Mengen werden mit personen/BASIS_PERSONEN skaliert und summiert.
 * - Department wird first-seen genommen; falls bisher leer, gewinnt das erste
 *   nicht-leere department das auftaucht.
 * - Output gruppiert nach Department in kanonischer Reihenfolge, „Sonstiges"
 *   immer am Ende.
 *
 * @param {Array<{rezept: {daten?: object}, personen: number}>} recipes
 * @returns {{liste: Array<{group: string, items: Array<{quantity: number, unit: string, name: string}>}>}}
 */
export function aggregateIngredients(recipes) {
    const aggregat = new Map();  // key → { name, unit, quantity, department }

    for (const { rezept, personen } of (recipes || [])) {
        const daten = rezept?.daten || {};
        const groups = Array.isArray(daten.ingredients) ? daten.ingredients : [];
        const faktor = (Number(personen) || BASIS_PERSONEN) / BASIS_PERSONEN;

        for (const group of groups) {
            if (!group || typeof group !== 'object') continue;
            const items = Array.isArray(group.items) ? group.items : [];
            for (const item of items) {
                if (!item || typeof item !== 'object') continue;
                const name = String(item.name ?? '').trim();
                if (name === '') continue;
                const unit = String(item.unit ?? '').trim();
                const quantity = typeof item.quantity === 'number'
                    ? item.quantity
                    : (parseFloat(item.quantity) || 0);
                // Department canonicalisieren: macht DE→EN, glättet Schreibweise.
                // Bestandsdaten (vor Mai 2026) haben hier noch deutsche Werte.
                const department = canonicalizeDepartment(item.department);

                const key = lower(name) + '||' + lower(unit);
                let entry = aggregat.get(key);
                if (!entry) {
                    entry = { name, unit, quantity: 0, department };
                    aggregat.set(key, entry);
                } else if (entry.department === '' && department !== '') {
                    entry.department = department;
                }
                entry.quantity += quantity * faktor;
            }
        }
    }

    // Pro Department sammeln
    const byDepartment = new Map();
    for (const entry of aggregat.values()) {
        const dept = entry.department !== '' ? entry.department : SONSTIGES;
        if (!byDepartment.has(dept)) byDepartment.set(dept, []);
        byDepartment.get(dept).push({
            quantity: roundQty(entry.quantity),
            unit: entry.unit,
            name: entry.name,
        });
    }

    // Items innerhalb jeder Gruppe alphabetisch sortieren (de-locale)
    for (const items of byDepartment.values()) {
        items.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    }

    // Output-Reihenfolge: kanonische Liste, dann unbekannte (alphabetisch),
    // Sonstiges immer am Ende.
    const liste = [];
    const seen = new Set();

    for (const dept of VALID_DEPARTMENTS) {
        if (byDepartment.has(dept)) {
            liste.push({ group: dept, items: byDepartment.get(dept) });
            seen.add(dept);
        }
    }

    const unknown = [...byDepartment.keys()]
        .filter(d => !seen.has(d) && d !== SONSTIGES)
        .sort((a, b) => a.localeCompare(b, 'de'));
    for (const dept of unknown) {
        liste.push({ group: dept, items: byDepartment.get(dept) });
    }

    if (byDepartment.has(SONSTIGES)) {
        liste.push({ group: SONSTIGES, items: byDepartment.get(SONSTIGES) });
    }

    return { liste };
}

/**
 * Union aller Gewürze über die Cart-Rezepte. Dedupliziert case-insensitiv,
 * alphabetisch sortiert. Liefert string[].
 */
export function aggregateSpices(recipes) {
    const seen = new Map();
    for (const { rezept } of (recipes || [])) {
        const spices = Array.isArray(rezept?.daten?.spices) ? rezept.daten.spices : [];
        for (const s of spices) {
            const trimmed = String(s ?? '').trim();
            if (trimmed === '') continue;
            const key = trimmed.toLowerCase();
            if (!seen.has(key)) seen.set(key, trimmed);
        }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'de'));
}

/**
 * Union der Küchenausstattung. Pro Item-Name den Maximum-Bedarf (kein Aufsummieren,
 * da Geräte wiederverwendbar sind). Liefert [{quantity, name}, ...].
 */
export function aggregateEquipment(recipes) {
    const map = new Map();
    for (const { rezept } of (recipes || [])) {
        const items = Array.isArray(rezept?.daten?.kitchen_equipment)
            ? rezept.daten.kitchen_equipment : [];
        for (const e of items) {
            if (!e || typeof e !== 'object') continue;
            const name = String(e.name ?? '').trim();
            if (name === '') continue;
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
