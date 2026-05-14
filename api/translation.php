<?php
declare(strict_types=1);

/**
 * Generische Input-Sanitisierung für Free-Text-Felder.
 * - Entfernt NULL-Bytes (können in einigen Kontexten injection-relevant werden)
 * - Entfernt Steuerzeichen außer Tab/LF/CR
 * - Trimmt auf $maxLen UTF-8-Codepoints
 * - Wenn $input gar kein String ist, leerer String zurück
 */
function sanitize_text(mixed $input, int $maxLen): string {
    if (!is_string($input)) return '';
    // NULL-Bytes und C0-Controls entfernen (außer Tab, LF, CR)
    $clean = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', $input) ?? $input;
    $clean = trim($clean);
    if (function_exists('mb_substr')) {
        return mb_substr($clean, 0, $maxLen, 'UTF-8');
    }
    return substr($clean, 0, $maxLen);
}

// Längen-Limits (UTF-8-Codepoints, nicht Bytes) für die wichtigsten Strings.
// Konservativ gewählt — normale Rezepte nutzen nirgends mehr als die Hälfte.
const MAX_TITLE_LEN       = 200;
const MAX_CATEGORY_LEN    = 100;
const MAX_SOURCE_LEN      = 200;
const MAX_TIME_LEN        = 100;
const MAX_GROUP_LEN       = 100;
const MAX_INGREDIENT_NAME = 200;
const MAX_UNIT_LEN        = 30;
const MAX_DEPT_LEN        = 50;
const MAX_SPICE_LEN       = 200;
const MAX_PREP_STEP_LEN   = 5000;
const MAX_TIP_LEN         = 2000;
const MAX_EQUIPMENT_NAME  = 200;
const MAX_TAG_LEN         = 50;

function load_translation_map(): array {
    $candidates = [
        __DIR__ . '/../translation_map.json',
        __DIR__ . '/translation_map.json',
    ];
    foreach ($candidates as $p) {
        if (!is_file($p) || !is_readable($p)) {
            continue;
        }
        $raw = @file_get_contents($p);
        if (!is_string($raw) || $raw === '') {
            continue;
        }
        $map = json_decode($raw, true);
        if (is_array($map) && isset($map['de_to_en']) && is_array($map['de_to_en'])) {
            return $map['de_to_en'];
        }
    }
    return [];
}

function translate_keys(mixed $node, array $map): mixed {
    if (is_array($node)) {
        if (array_is_list($node)) {
            return array_map(fn($v) => translate_keys($v, $map), $node);
        }
        $out = [];
        foreach ($node as $key => $value) {
            $newKey = $map[$key] ?? $key;
            $out[$newKey] = translate_keys($value, $map);
        }
        return $out;
    }
    return $node;
}

/**
 * Mapping eingehender Einheit -> [kanonische Einheit, Multiplikator für quantity].
 * Erlaubte kanonische Werte: '', 'g', 'ml', 'Pck', 'Pcs'.
 * Mathematische Umrechnungen sind bewusst hier hartkodiert (Single Source of Truth) —
 * translation_map.json spiegelt die rein wertbasierten Mappings für Anzeige/Doku.
 */
function unit_normalization_map(): array {
    return [
        // kanonische Pass-throughs
        'g'       => ['g',   1.0],
        'ml'      => ['ml',  1.0],
        'Pck'     => ['Pck', 1.0],
        'Pcs'     => ['Pcs', 1.0],
        // Masse / Volumen
        'kg'      => ['g',   1000.0],
        'L'       => ['ml',  1000.0],
        'l'       => ['ml',  1000.0],
        // Esslöffel / Teelöffel (Faustregel)
        'EL'      => ['g',   15.0],
        'TL'      => ['g',   5.0],
        // Stück / Packung
        'Stück'   => ['Pcs', 1.0],
        'Stueck'  => ['Pcs', 1.0],
        'Stk'     => ['Pcs', 1.0],
        'Packung' => ['Pck', 1.0],
    ];
}

/**
 * Normalisiert eine einzelne Einheit. Gibt [neue_menge, kanonische_einheit] zurück
 * oder null wenn die Einheit unbekannt ist.
 */
function normalize_single_unit(float $quantity, string $unit): ?array {
    $unit = trim($unit);
    if ($unit === '') {
        return [$quantity, ''];
    }
    $map = unit_normalization_map();

    // Exakter Match zuerst — sonst case-insensitiver Fallback gegen alle Map-Keys
    $lookup = $map[$unit] ?? null;
    if ($lookup === null) {
        $lower = strtolower($unit);
        foreach ($map as $k => $v) {
            if (strtolower($k) === $lower) {
                $lookup = $v;
                break;
            }
        }
    }
    if ($lookup === null) {
        return null;
    }
    [$canonical, $factor] = $lookup;
    return [$quantity * $factor, $canonical];
}

/**
 * Erlaubte Abteilungen (Departments) in kanonischer Schreibweise.
 * Ab Mai 2026 sind das englische Slugs — sie werden so in der DB gespeichert.
 * Die UI übersetzt sie über `assets/aggregate.js::displayDepartment` ins
 * Deutsche zurück. Reihenfolge ist relevant — wird in einkaufsliste.php
 * fürs Sortieren genutzt.
 */
function valid_departments(): array {
    return [
        'fruit/vegetables',
        'fresh-counter',
        'bakery',
        'cooling',
        'non-food',
        'drinks',
        'breakfast',
        'baking',
        'staple-foods',
    ];
}

/**
 * DE→EN-Mapping. Wird bei Upload/PUT verwendet um deutsche Werte aus
 * Bestandsdaten und händisch geschriebenen JSON-Files automatisch in die
 * kanonische englische Form zu übersetzen.
 */
function german_to_english_department(): array {
    return [
        'Obst/Gemüse'         => 'fruit/vegetables',
        'Frische Theke'       => 'fresh-counter',
        'Bäckerei'            => 'bakery',
        'Kühlung'             => 'cooling',
        'Non-Food'            => 'non-food',
        'Getränke'            => 'drinks',
        'Frühstück'           => 'breakfast',
        'Backen'              => 'baking',
        'Grundnahrungsmittel' => 'staple-foods',
    ];
}

/**
 * Akzeptiert deutsche ODER englische Department-Schreibweise (case-insensitiv)
 * und gibt immer die englische kanonische Form zurück. Leerer Wert → ''. Wenn
 * weder ein bekannter englischer Slug noch ein deutscher Alias gefunden wird,
 * wird null zurückgegeben (= Validierungsfehler beim Upload, oder Fallback
 * auf „other" bei nicht-strikter Aggregation).
 */
function canonicalize_department(string $value): ?string {
    $value = trim($value);
    if ($value === '') return '';

    // Englisch direkt (kanonisch oder anders kapitalisiert)
    $canonical = valid_departments();
    if (in_array($value, $canonical, true)) return $value;
    $lower = strtolower($value);
    foreach ($canonical as $c) {
        if (strtolower($c) === $lower) return $c;
    }

    // Deutsch
    $de2en = german_to_english_department();
    if (isset($de2en[$value])) return $de2en[$value];
    foreach ($de2en as $de => $en) {
        if (strtolower($de) === $lower) return $en;
    }
    return null;
}

/**
 * @deprecated zugunsten canonicalize_department() — bleibt als Alias erhalten
 * für ggf. externe Konsumenten.
 */
function normalize_single_department(string $dept): ?string {
    return canonicalize_department($dept);
}

/**
 * Erlaubte Diät-Tags. Aktuell nur vegan und vegetarian — die Liste ist
 * bewusst klein und kuratiert, statt freiform Tags zuzulassen (sonst zerfasert
 * der Filter sofort über Schreibvarianten wie „Vegi"/„Vegg" etc.).
 * Bei Erweiterung: hier den Slug ergänzen + UI-Labels in `aggregate.js` /
 * `tags_en_to_de` in `translation_map.json`.
 */
function valid_tags(): array {
    return ['vegan', 'vegetarian'];
}

/**
 * DE→EN-Mapping für Tag-Werte. Wird beim Upload/PUT verwendet damit User
 * deutsche Wörter im JSON nutzen können.
 */
function german_to_english_tag(): array {
    return [
        'vegan'        => 'vegan',
        'vegetarisch'  => 'vegetarian',
    ];
}

/**
 * Akzeptiert deutsche ODER englische Tag-Schreibweise (case-insensitiv) und
 * gibt den englischen kanonischen Slug zurück. Leer → null. Unbekannt → null.
 */
function canonicalize_tag(string $value): ?string {
    $value = trim($value);
    if ($value === '') return null;
    $lower = strtolower($value);

    foreach (valid_tags() as $slug) {
        if (strtolower($slug) === $lower) return $slug;
    }
    $de2en = german_to_english_tag();
    if (isset($de2en[$lower])) return $de2en[$lower];
    return null;
}

/**
 * Validiert das `rating`-Feld: Integer in [1..5] wird kanonisch als Int
 * gespeichert. 0, leer, null oder fehlend → Feld weg (= „nicht bewertet").
 * Andere Werte → Validierungsfehler.
 */
function normalize_rating_in_recipe(array &$recipe, array &$errors): void {
    if (!array_key_exists('rating', $recipe)) return;

    $raw = $recipe['rating'];
    if ($raw === null || $raw === '' || $raw === 0 || $raw === '0') {
        unset($recipe['rating']);
        return;
    }
    // Strings wie "4" tolerieren — KI-Outputs kommen oft als Strings.
    if (is_string($raw) && preg_match('/^[0-9]+$/', trim($raw))) {
        $raw = (int) trim($raw);
    }
    if (!is_int($raw) || $raw < 1 || $raw > 5) {
        $errors[] = sprintf('Rating muss eine Ganzzahl zwischen 1 und 5 sein (oder weggelassen werden), erhalten: %s', json_encode($recipe['rating']));
        unset($recipe['rating']);
        return;
    }
    $recipe['rating'] = $raw;
}

/**
 * Normalisiert das tags-Array in-place: trimmt, canonicalisiert (DE→EN),
 * dedupliziert in stabiler Reihenfolge (= Reihenfolge in valid_tags). Wirft
 * Validierungsfehler in $errors bei unbekannten Werten oder falschem Typ.
 * Wenn das Feld fehlt, wird leeres Array eingesetzt.
 */
function normalize_tags_in_recipe(array &$recipe, array &$errors): void {
    if (!array_key_exists('tags', $recipe)) {
        $recipe['tags'] = [];
        return;
    }
    if (!is_array($recipe['tags']) || !array_is_list($recipe['tags'])) {
        $errors[] = 'Feld "tags" muss ein Array sein';
        $recipe['tags'] = [];
        return;
    }
    $clean = [];
    foreach ($recipe['tags'] as $raw) {
        if (!is_string($raw)) {
            $errors[] = 'tags darf nur Strings enthalten';
            continue;
        }
        $sanitized = sanitize_text($raw, MAX_TAG_LEN);
        if ($sanitized === '') continue;
        $canon = canonicalize_tag($sanitized);
        if ($canon === null) {
            $valid = implode('", "', valid_tags());
            $errors[] = sprintf('Unbekannter Tag "%s". Erlaubt: "%s"', $sanitized, $valid);
            continue;
        }
        $clean[$canon] = true;  // Dedup via Key
    }
    // In kanonischer Reihenfolge ausgeben — UI/DB-Pretty-Print profitieren
    $ordered = [];
    foreach (valid_tags() as $slug) {
        if (isset($clean[$slug])) $ordered[] = $slug;
    }
    $recipe['tags'] = $ordered;
}

/**
 * Geht alle ingredients[].items[] durch und normalisiert die Departments in-place.
 * Sammelt unbekannte Werte in $errors.
 */
function normalize_departments_in_recipe(array &$recipe, array &$errors): void {
    if (!isset($recipe['ingredients']) || !is_array($recipe['ingredients'])) {
        return;
    }
    foreach ($recipe['ingredients'] as $gi => $group) {
        if (!is_array($group) || !isset($group['items']) || !is_array($group['items'])) {
            continue;
        }
        foreach ($group['items'] as $ii => $item) {
            if (!is_array($item) || !isset($item['department'])) {
                continue; // Feld ist optional
            }
            $dept = (string) $item['department'];
            $normalized = normalize_single_department($dept);
            if ($normalized === null) {
                $name = trim((string) ($item['name'] ?? ''));
                $where = $name !== '' ? "Zutat \"$name\"" : 'eine Zutat';
                $valid = implode('", "', valid_departments());
                $errors[] = sprintf('Unbekannte Abteilung "%s" bei %s. Erlaubt: "%s"', $dept, $where, $valid);
                continue;
            }
            if ($normalized === '') {
                unset($recipe['ingredients'][$gi]['items'][$ii]['department']);
            } else {
                $recipe['ingredients'][$gi]['items'][$ii]['department'] = $normalized;
            }
        }
    }
}

/**
 * Geht alle ingredients[].items[] durch und normalisiert die Einheiten in-place.
 * Sammelt alle nicht-konvertierbaren Einheiten in $errors.
 */
function normalize_units_in_recipe(array &$recipe, array &$errors): void {
    if (!isset($recipe['ingredients']) || !is_array($recipe['ingredients'])) {
        return;
    }
    foreach ($recipe['ingredients'] as $gi => $group) {
        if (!is_array($group) || !isset($group['items']) || !is_array($group['items'])) {
            continue;
        }
        foreach ($group['items'] as $ii => $item) {
            if (!is_array($item)) {
                continue;
            }
            $unit = (string) ($item['unit'] ?? '');
            $quantity = (float) ($item['quantity'] ?? 0);

            $result = normalize_single_unit($quantity, $unit);
            if ($result === null) {
                $name = trim((string) ($item['name'] ?? ''));
                $where = $name !== '' ? "Zutat \"$name\"" : 'eine Zutat';
                $errors[] = sprintf('Unbekannte Einheit "%s" bei %s', $unit, $where);
                continue;
            }
            [$newQty, $canonical] = $result;
            $recipe['ingredients'][$gi]['items'][$ii]['quantity'] = $newQty;
            $recipe['ingredients'][$gi]['items'][$ii]['unit']     = $canonical;
        }
    }
}

/**
 * Wird vom Batch-Import per try/catch verwendet, damit per-record-Validation
 * möglich ist. Wirft RecipeValidationException statt das Script zu beenden.
 */
class RecipeValidationException extends Exception {}

/**
 * Validiert + normalisiert ein Rezept. Wirft RecipeValidationException bei
 * Fehlern. Single-Request-Endpunkte nutzen die Wrapper-Funktion `normalize_recipe`
 * unten die in `json_error` übersetzt.
 */
function normalize_recipe_strict(mixed $data): array {
    if (!is_array($data) || array_is_list($data)) {
        throw new RecipeValidationException('JSON muss ein Objekt sein');
    }
    $map = load_translation_map();
    $normalized = translate_keys($data, $map);

    if (empty($normalized['title']) || !is_string($normalized['title'])) {
        throw new RecipeValidationException('Pflichtfeld "title" (oder "titel") fehlt');
    }
    if (empty($normalized['ingredients']) || !is_array($normalized['ingredients'])) {
        throw new RecipeValidationException('Pflichtfeld "ingredients" (oder "zutaten") fehlt');
    }

    // Längenlimits + Sanitisierung der Top-Level-Strings
    $normalized['title'] = sanitize_text($normalized['title'], MAX_TITLE_LEN);
    if ($normalized['title'] === '') {
        throw new RecipeValidationException('Feld "title" ist nach Sanitisierung leer');
    }
    foreach (['category' => MAX_CATEGORY_LEN, 'source' => MAX_SOURCE_LEN, 'preparation_time' => MAX_TIME_LEN] as $k => $lim) {
        if (isset($normalized[$k])) {
            $normalized[$k] = sanitize_text($normalized[$k], $lim);
            if ($normalized[$k] === '') unset($normalized[$k]);
        }
    }

    // Ingredient-Gruppen und Items
    foreach ($normalized['ingredients'] as $gi => &$group) {
        if (!is_array($group)) { unset($normalized['ingredients'][$gi]); continue; }
        if (isset($group['group'])) {
            $group['group'] = sanitize_text($group['group'], MAX_GROUP_LEN);
        }
        if (isset($group['items']) && is_array($group['items'])) {
            foreach ($group['items'] as $ii => &$item) {
                if (!is_array($item)) { unset($group['items'][$ii]); continue; }
                if (isset($item['name'])) $item['name'] = sanitize_text($item['name'], MAX_INGREDIENT_NAME);
                if (isset($item['unit'])) $item['unit'] = sanitize_text($item['unit'], MAX_UNIT_LEN);
                if (isset($item['department'])) $item['department'] = sanitize_text($item['department'], MAX_DEPT_LEN);
                // quantity wird unten in normalize_units_in_recipe als float behandelt
            }
            unset($item);
            $group['items'] = array_values($group['items']);
        }
    }
    unset($group);
    $normalized['ingredients'] = array_values($normalized['ingredients']);

    // Listen-Strings: spices, preparation, tips
    foreach (['spices' => MAX_SPICE_LEN, 'preparation' => MAX_PREP_STEP_LEN, 'tips' => MAX_TIP_LEN] as $k => $lim) {
        if (isset($normalized[$k]) && is_array($normalized[$k])) {
            $cleaned = [];
            foreach ($normalized[$k] as $entry) {
                $s = sanitize_text($entry, $lim);
                if ($s !== '') $cleaned[] = $s;
            }
            $normalized[$k] = $cleaned;
        }
    }

    // Küchenausstattung
    if (isset($normalized['kitchen_equipment']) && is_array($normalized['kitchen_equipment'])) {
        foreach ($normalized['kitchen_equipment'] as $ei => &$e) {
            if (!is_array($e)) { unset($normalized['kitchen_equipment'][$ei]); continue; }
            if (isset($e['name'])) $e['name'] = sanitize_text($e['name'], MAX_EQUIPMENT_NAME);
        }
        unset($e);
        $normalized['kitchen_equipment'] = array_values($normalized['kitchen_equipment']);
    }

    $unitErrors = [];
    normalize_units_in_recipe($normalized, $unitErrors);
    if (!empty($unitErrors)) {
        throw new RecipeValidationException('Einheiten-Fehler: ' . implode('; ', $unitErrors));
    }

    $deptErrors = [];
    normalize_departments_in_recipe($normalized, $deptErrors);
    if (!empty($deptErrors)) {
        throw new RecipeValidationException('Abteilungs-Fehler: ' . implode('; ', $deptErrors));
    }

    $tagErrors = [];
    normalize_tags_in_recipe($normalized, $tagErrors);
    if (!empty($tagErrors)) {
        throw new RecipeValidationException('Tag-Fehler: ' . implode('; ', $tagErrors));
    }

    $ratingErrors = [];
    normalize_rating_in_recipe($normalized, $ratingErrors);
    if (!empty($ratingErrors)) {
        throw new RecipeValidationException('Rating-Fehler: ' . implode('; ', $ratingErrors));
    }

    return $normalized;
}

/**
 * Bildet das tags-Array auf den DB-Spalten-String ab: comma-wrapped
 * (",vegan,vegetarian,") damit ein einfaches LIKE '%,vegan,%' eindeutig
 * matched. Leeres Array → null (Spalte bleibt NULL).
 */
function tags_to_column(array $tags): ?string {
    if (empty($tags)) return null;
    return ',' . implode(',', $tags) . ',';
}

/**
 * Umkehrung von tags_to_column — liest den Spalten-Wert zurück in ein Array.
 * Robust gegen NULL/empty/whitespace.
 */
function column_to_tags(?string $value): array {
    if ($value === null) return [];
    $trimmed = trim($value, ", \t\r\n");
    if ($trimmed === '') return [];
    return array_values(array_filter(explode(',', $trimmed), fn($t) => $t !== ''));
}

function normalize_recipe(mixed $data): array {
    try {
        return normalize_recipe_strict($data);
    } catch (RecipeValidationException $e) {
        json_error($e->getMessage(), 400);
    }
}
