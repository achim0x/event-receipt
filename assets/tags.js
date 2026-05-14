// Frontend-Konstanten + Display-Helpers für die Rezept-Tags.
// Spiegelt `valid_tags()` und `german_to_english_tag()` aus
// `api/translation.php` plus die Label-Map aus `translation_map.json`
// (`tags_en_to_de`). Backend bleibt single source of truth — diese Datei
// liefert nur die UI-Repräsentation.

export const VALID_TAGS = ['vegan', 'vegetarian'];

const TAG_EN_TO_DE = {
    'vegan':      'Vegan',
    'vegetarian': 'Vegetarisch',
};

const TAG_DE_TO_EN = {
    'vegan':       'vegan',
    'vegetarisch': 'vegetarian',
};

/**
 * Akzeptiert deutsche oder englische Schreibweise (case-insensitiv) und
 * gibt den kanonischen englischen Slug zurück. Unbekannt/leer → null.
 */
export function canonicalizeTag(value) {
    const v = String(value ?? '').trim().toLowerCase();
    if (!v) return null;
    for (const slug of VALID_TAGS) {
        if (slug.toLowerCase() === v) return slug;
    }
    return TAG_DE_TO_EN[v] ?? null;
}

/** Übersetzt einen Slug für die UI ins Deutsche. Unbekannt → Slug zurück. */
export function displayTag(slug) {
    if (!slug) return '';
    return TAG_EN_TO_DE[slug] ?? slug;
}
