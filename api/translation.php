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
    return $normalized;
}
