<?php
declare(strict_types=1);

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
 * Reihenfolge ist relevant — wird in einkaufsliste.php fürs Sortieren genutzt.
 */
function valid_departments(): array {
    return [
        'Obst/Gemüse',
        'Frische Theke',
        'Non-Food',
        'Getränke',
        'Backen',
        'Grundnahrungsmittel',
    ];
}

/**
 * Normalisiert eine eingehende Department-Angabe auf die kanonische Schreibweise.
 * Match ist case-insensitiv. Gibt null zurück wenn unbekannt.
 * Leere/whitespace-only Eingabe → ['' (leer), true] (gültig, kein Department).
 */
function normalize_single_department(string $dept): ?string {
    $dept = trim($dept);
    if ($dept === '') return '';

    $canonical = valid_departments();
    if (in_array($dept, $canonical, true)) return $dept;

    $lower = strtolower($dept);
    foreach ($canonical as $c) {
        if (strtolower($c) === $lower) return $c;
    }
    return null;
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

function normalize_recipe(mixed $data): array {
    if (!is_array($data) || array_is_list($data)) {
        json_error('JSON muss ein Objekt sein', 400);
    }
    $map = load_translation_map();
    $normalized = translate_keys($data, $map);

    if (empty($normalized['title']) || !is_string($normalized['title'])) {
        json_error('Pflichtfeld "title" (oder "titel") fehlt', 400);
    }
    if (empty($normalized['ingredients']) || !is_array($normalized['ingredients'])) {
        json_error('Pflichtfeld "ingredients" (oder "zutaten") fehlt', 400);
    }

    $unitErrors = [];
    normalize_units_in_recipe($normalized, $unitErrors);
    if (!empty($unitErrors)) {
        json_error('Einheiten-Fehler: ' . implode('; ', $unitErrors), 400);
    }

    $deptErrors = [];
    normalize_departments_in_recipe($normalized, $deptErrors);
    if (!empty($deptErrors)) {
        json_error('Abteilungs-Fehler: ' . implode('; ', $deptErrors), 400);
    }

    return $normalized;
}
