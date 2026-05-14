// Anzeige-Übersetzung für die kanonisch in der DB stehenden Einheiten.
// Spiegelt translation_map.json `units_en_to_de`.
const UNITS_EN_TO_DE = {
    'Pcs': 'Stück',
    'Pck': 'Packung',
};

export function displayUnit(unit) {
    if (!unit) return '';
    return UNITS_EN_TO_DE[unit] ?? unit;
}

// Spiegelt `unit_normalization_map()` aus api/translation.php. Wird
// gebraucht, wenn der Client einen Wert speichert der dann später per Key
// (= name||unit) wiedergefunden werden muss — z.B. Häkchen-Status auf
// freien Zutaten. Server normalisiert ohnehin nochmal beim Speichern.
const UNIT_NORMALIZATION = {
    // kanonische Pass-throughs (immer schon klein normalisiert)
    'g':       ['g',   1.0],
    'ml':      ['ml',  1.0],
    'Pck':     ['Pck', 1.0],
    'Pcs':     ['Pcs', 1.0],
    // Masse / Volumen
    'kg':      ['g',   1000.0],
    'L':       ['ml',  1000.0],
    'l':       ['ml',  1000.0],
    // Löffel
    'EL':      ['g',   15.0],
    'TL':      ['g',   5.0],
    // Stück / Packung
    'Stück':   ['Pcs', 1.0],
    'Stueck':  ['Pcs', 1.0],
    'Stk':     ['Pcs', 1.0],
    'Packung': ['Pck', 1.0],
};

/**
 * Normalisiert {quantity, unit} clientseitig analog zum Server.
 * Unbekannte Einheiten bleiben unverändert (kein Fehler — der Aufrufer
 * speichert dann eben den User-Wert; Server tut hier dasselbe).
 * Returns: {quantity: number, unit: string}.
 */
export function normalizeQuantityUnit(quantity, unit) {
    const q = Number.isFinite(quantity) ? Number(quantity) : 0;
    const u = String(unit ?? '').trim();
    if (u === '') return { quantity: q, unit: '' };

    // exakt match → case-insensitiver Fallback
    let lookup = UNIT_NORMALIZATION[u];
    if (!lookup) {
        const lower = u.toLowerCase();
        for (const [k, v] of Object.entries(UNIT_NORMALIZATION)) {
            if (k.toLowerCase() === lower) { lookup = v; break; }
        }
    }
    if (!lookup) return { quantity: q, unit: u };  // unbekannt → 1:1 durch
    const [canonical, factor] = lookup;
    return { quantity: q * factor, unit: canonical };
}
