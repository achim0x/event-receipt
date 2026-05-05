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
