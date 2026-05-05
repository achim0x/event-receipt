# Rezept-Datenbank Web-App — Projektspezifikation

## Stack
- **Frontend**: Vanilla JS (ES6+), HTML5, CSS3
- **Backend**: PHP 8.x
- **Datenbank**: SQLite3 (via PHP PDO)
- **Server**: Apache mit mod_rewrite

---

## Projektstruktur

```
rezepte/
├── index.html                  # SPA-Shell
├── .htaccess                   # Apache Rewrite-Regeln
├── assets/
│   ├── app.js                  # Haupt-JS (Router + State)
│   ├── api.js                  # Fetch API Wrapper
│   ├── views/
│   │   ├── rezepte.js          # Rezeptliste & Detailansicht
│   │   ├── upload.js           # JSON Upload
│   │   └── einkaufsliste.js    # Einkaufslistengenerator
│   └── style.css
├── api/
│   ├── bootstrap.php           # DB-Verbindung, CORS-Header
│   ├── rezepte.php             # GET /api/rezepte, GET /api/rezepte/{id}
│   ├── upload.php              # POST /api/upload
│   └── einkaufsliste.php       # POST /api/einkaufsliste
└── data/
    └── .gitkeep                # SQLite DB wird hier erstellt (rezepte.db)
```

---

## Datenbank-Schema (SQLite)

```sql
-- Rezepte Tabelle
CREATE TABLE IF NOT EXISTS rezepte (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    titel       TEXT NOT NULL,
    kategorie   TEXT,
    quelle      TEXT,
    zubereitungszeit TEXT,
    daten       TEXT NOT NULL,  -- komplettes JSON als blob
    erstellt_am DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index für Suche
CREATE INDEX IF NOT EXISTS idx_titel ON rezepte(titel);
CREATE INDEX IF NOT EXISTS idx_kategorie ON rezepte(kategorie);
```

> **Hinweis**: Das gesamte Rezept-JSON wird in der Spalte `daten` gespeichert.
> Titel, Kategorie etc. werden zusätzlich als Felder gespiegelt für Suche/Filter.

---

## JSON-Format (Rezept)

Basierend auf `recipe_template.json`:

```json
{
  "title": "Spaghetti Carbonara",
  "category": "Pasta",
  "source": "Nonna Maria",
  "preparation_time": "30 Minuten",
  "ingredients": [
    {
      "group": "Teig",
      "items": [
        { "quantity": 400, "unit": "g", "name": "Spaghetti" },
        { "quantity": 200, "unit": "g", "name": "Pancetta" }
      ]
    }
  ],
  "spices": ["Schwarzer Pfeffer", "Salz"],
  "preparation": [
    "Wasser zum Kochen bringen.",
    "Pancetta in einer Pfanne anbraten."
  ],
  "tips": ["Kein Speck durch Bacon ersetzen."],
  "kitchen_equipment": [
    { "quantity": 1, "name": "Großer Topf" }
  ]
}
```

---

## Translation Map

Für die Übersetzung zwischen DE/EN Keys steht `translation_map.json` bereit:

```json
{
  "de_to_en": { "titel": "title", "zutaten": "ingredients", ... },
  "en_to_de": { "title": "titel", "ingredients": "zutaten", ... }
}
```

> Die `upload.php` soll beim Import automatisch DE-Keys in EN-Keys umwandeln,
> sofern das hochgeladene JSON noch deutsche Schlüssel verwendet.

---

## API-Endpunkte

### `GET /api/rezepte`
Gibt alle Rezepte zurück (ohne den vollen JSON-Blob).

**Response:**
```json
[
  { "id": 1, "titel": "Carbonara", "kategorie": "Pasta", "zubereitungszeit": "30 min" }
]
```

Query-Parameter:
- `?suche=carbonara` — Volltextsuche auf `titel`
- `?kategorie=Pasta` — Filter nach Kategorie

---

### `GET /api/rezepte/{id}`
Gibt ein einzelnes Rezept mit vollem JSON-Blob zurück.

**Response:**
```json
{ "id": 1, "titel": "Carbonara", "daten": { ... } }
```

---

### `POST /api/upload`
Lädt ein Rezept als JSON hoch.

**Request:** `multipart/form-data` mit Feld `datei` (JSON-Datei)

**Validierung:**
- Pflichtfelder: `title` (oder `titel`), `ingredients` (oder `zutaten`)
- Max. Dateigröße: 1 MB
- Automatische DE→EN Key-Übersetzung via `translation_map.json`

**Response:**
```json
{ "success": true, "id": 42 }
```

---

### `POST /api/einkaufsliste`
Generiert eine aggregierte Einkaufsliste aus mehreren Rezepten.

**Request:**
```json
{
  "rezepte": [
    { "id": 1, "personen": 4 },
    { "id": 3, "personen": 2 }
  ]
}
```

**Logik (PHP):**
1. Rezepte anhand der IDs aus SQLite laden
2. Für jedes Rezept die Basismenge (Standard: 4 Personen) mit Faktor `personen / basis_personen` multiplizieren
3. Gleiche Zutaten (matching auf `name` + `unit`) summieren
4. Nach Gruppen sortiert zurückgeben

**Response:**
```json
{
  "liste": [
    {
      "group": "Teig",
      "items": [
        { "quantity": 800, "unit": "g", "name": "Spaghetti" }
      ]
    }
  ]
}
```

---

## Frontend Views

### View 1: Rezeptliste (`/`)
- Alle Rezepte als Karten anzeigen
- Suchfeld (live filter via `GET /api/rezepte?suche=...`)
- Filter-Dropdown nach Kategorie
- Klick auf Karte → Detailansicht

### View 2: Rezept-Detailansicht (`/rezept/{id}`)
- Vollständiges Rezept anzeigen
- Personenanzahl-Eingabe (Spinner, Default: 4)
- Zutatenmengen werden live im Frontend skaliert
- Button: "Zur Einkaufsliste hinzufügen"

### View 3: Upload (`/upload`)
- Drag & Drop oder File-Picker für JSON
- Vorschau des geparsten Rezepts vor dem Speichern
- Fehleranzeige bei ungültigem Format

### View 4: Einkaufsliste (`/einkaufsliste`)
- Ausgewählte Rezepte mit Personenzahl verwalten
- Button "Liste generieren" → POST `/api/einkaufsliste`
- Ergebnis als gruppierte Liste anzeigen
- Export-Funktion: Als Text kopieren oder als `.txt` herunterladen

---

## Frontend State-Management

Minimaler globaler State in `app.js`:

```js
const state = {
  einkaufsliste: []  // [{ id, titel, personen }]
};
```

Persistenz via `localStorage` damit die Auswahl beim Neuladen erhalten bleibt.

---

## Apache `.htaccess`

```apache
RewriteEngine On
RewriteCond %{REQUEST_URI} ^/api/
RewriteRule ^ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^ index.html [L]
```

---

## PHP Bootstrap (`api/bootstrap.php`)

```php
<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$db = new PDO('sqlite:' . __DIR__ . '/../data/rezepte.db');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

// Schema anlegen falls nicht vorhanden
$db->exec("
    CREATE TABLE IF NOT EXISTS rezepte (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titel TEXT NOT NULL,
        kategorie TEXT,
        quelle TEXT,
        zubereitungszeit TEXT,
        daten TEXT NOT NULL,
        erstellt_am DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_titel ON rezepte(titel);
    CREATE INDEX IF NOT EXISTS idx_kategorie ON rezepte(kategorie);
");
```

---

## Hinweise für Claude Code

1. **Einstieg**: Beginne mit `api/bootstrap.php` und `api/rezepte.php`, dann `api/upload.php`
2. **SQLite-Pfad**: Die `data/`-Datei muss für Apache/PHP beschreibbar sein (`chmod 775 data/`)
3. **Basis-Personenzahl**: Da das JSON-Template keine Personenzahl enthält, verwende **1 Person** als festen Default für die Skalierungsberechnung
4. **Key-Normalisierung**: `upload.php` lädt `translation_map.json` und normalisiert alle Keys auf EN vor dem Speichern
5. **Fehlerbehandlung**: Alle API-Endpunkte sollen bei Fehlern `{"error": "Beschreibung"}` mit passendem HTTP-Statuscode zurückgeben
6. **Kein Build-Step**: Kein Bundler, kein npm — alles plain files die Apache direkt serviert

---

## Dateien die bereits existieren

| Datei | Beschreibung |
|---|---|
| `recipe_template.json` | Leere Vorlage für ein Rezept (EN Keys) |
| `translation_map.json` | DE↔EN Key-Mapping für den Upload |
