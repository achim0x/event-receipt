# Rezept-App — Entwicklerdokumentation

> Quelle der Wahrheit für die Implementierung. Erweitert die ursprüngliche
> [`REZEPT_APP_SPEC.md`](REZEPT_APP_SPEC.md) um alles, was sich während der
> Umsetzung gegenüber der Spec geändert oder konkretisiert hat. Bei
> Widerspruch zwischen Spec und diesem Dokument **gilt dieses Dokument**.

---

## 1. Stack & Voraussetzungen

| Komponente | Version |
|---|---|
| PHP        | 8.3 (strict_types in allen Dateien) |
| Apache     | 2.4 mit `mod_rewrite`, `AllowOverride All` für `/var/www/` |
| PHP-Extensions (Pflicht) | `pdo_sqlite`, `json` |
| PHP-Extensions (optional) | `mbstring` — Fallback auf `strtolower()` ist drin |
| Frontend | Vanilla ES-Modules, kein Build-Step |

**System-Setup** (einmalig, einzeln zu erledigen — Claude Code kann das nicht ohne `sudo`-Passwort):

```bash
sudo apt install -y php-sqlite3
sudo a2enmod rewrite
# In /etc/apache2/apache2.conf den Block <Directory /var/www/> auf
# AllowOverride All setzen, dann:
sudo systemctl reload apache2
```

**Dateirechte** (sonst 500 in `upload.php`):

```bash
chmod 644 translation_map.json recipe_template.json
chmod 777 data/        # Apache muss SQLite-DB anlegen können
```

---

## 2. Projektstruktur (Ist-Zustand)

```
<app-root>/                     # Root oder beliebiges Unterverzeichnis (z.B. /rezepte/)
├── index.php                   # SPA-Shell, setzt <base href="..."> dynamisch
├── .htaccess                   # Rewrite: api/* → PHP, alles andere → index.php
├── REZEPT_APP_SPEC.md          # Original-Spec (historisch)
├── DEVELOPER.md                # dieses Dokument
├── recipe_template.json        # leere Vorlage (EN-Keys)
├── translation_map.json        # DE↔EN Key + Unit Mapping
├── api/
│   ├── bootstrap.php           # PDO + Schema + CORS + Error-Handler
│   ├── translation.php         # DE→EN Keys + Einheiten-Normalisierung + Validierung
│   ├── rezepte.php             # GET-Liste, GET-Einzeln, PUT, DELETE
│   ├── upload.php              # POST (multipart oder raw JSON) → dry_run / INSERT
│   ├── einkaufsliste.php       # POST → aggregierte Zutatenliste
│   ├── cart.php                # GET / PUT — geteilter aktueller Cart (Singleton)
│   ├── saved_lists.php         # GET / POST / DELETE — benannte gespeicherte Listen
│   ├── checks.php              # GET / POST / DELETE — geteilte abgehakt-Markierungen
│   ├── export.php              # GET — komplette Sammlung als JSON-Wrapper
│   └── import.php              # POST — Batch-Import mit per-recipe-Validation
├── assets/
│   ├── config.js               # APP_BASE — aus import.meta.url abgeleitet
│   ├── app.js                  # Router + Cart-State (server-backed, lokal gemirrort)
│   ├── api.js                  # Fetch-Wrapper, BASE = APP_BASE + 'api'
│   ├── units.js                # displayUnit() — Pcs→Stück, Pck→Packung
│   ├── style.css
│   └── views/
│       ├── rezepte.js          # List, Detail, Edit (renderRezept{Liste,Detail,Edit})
│       ├── rezepte_print.js    # Druck-/PDF-Ansicht aller Cart-Rezepte
│       ├── upload.js           # Drag&Drop, dry-run-Vorschau, Save/Abbrechen
│       └── einkaufsliste.js    # Cart, Zutaten/Gewürze/Equipment-Aggregation, Export
└── data/
    └── rezepte.db              # SQLite (wird beim ersten API-Call angelegt)
```

---

## 3. Datenbank-Schema

Wird von `bootstrap.php` idempotent angelegt:

```sql
CREATE TABLE IF NOT EXISTS rezepte (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    titel           TEXT NOT NULL,
    kategorie       TEXT,
    quelle          TEXT,
    zubereitungszeit TEXT,
    daten           TEXT NOT NULL,  -- normalisierter JSON-Blob (EN-Keys)
    erstellt_am     DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_titel ON rezepte(titel);
CREATE INDEX IF NOT EXISTS idx_kategorie ON rezepte(kategorie);

-- Geteilte aktuelle Einkaufsliste (Singleton — genau eine Zeile id=1)
CREATE TABLE IF NOT EXISTS einkaufsliste_aktuell (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    items TEXT NOT NULL DEFAULT '[]',     -- JSON: [{id, titel, personen}]
    snapshot TEXT NOT NULL DEFAULT '{}',  -- JSON: {id: {titel, kategorie, quelle, zubereitungszeit, daten}}
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO einkaufsliste_aktuell (id, items) VALUES (1, '[]');

-- Benannte gespeicherte Listen (mit eingefrorenem Recipe-Snapshot)
CREATE TABLE IF NOT EXISTS einkaufsliste_gespeichert (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    items TEXT NOT NULL,
    snapshot TEXT NOT NULL DEFAULT '{}',
    gespeichert_am DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Abgehakte Einträge (geteilt). Schlüssel ist 'name_lower||unit_lower'.
-- Bewusst ohne quantity im Key → Personenzahl-Änderung erhält den Check.
CREATE TABLE IF NOT EXISTS einkaufsliste_abgehakt (
    kategorie TEXT NOT NULL,    -- 'zutaten' / 'gewuerze' / 'equipment'
    schluessel TEXT NOT NULL,   -- z.B. 'mehl||g' oder 'salz||'
    abgehakt_am DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (kategorie, schluessel)
);
```

**Konvention**: `daten` enthält das vollständige Rezept-JSON mit EN-Keys.
Die Spalten `titel`, `kategorie`, `quelle`, `zubereitungszeit` sind
**denormalisierte Spiegelfelder** für Suche/Filter/Listen-Performance.
Bei jedem `INSERT` und `UPDATE` werden sie aus dem normalisierten JSON
mitgeschrieben.

---

## 4. JSON-Format (Rezept)

Kanonische Form (EN-Keys, in der DB so abgelegt):

```json
{
  "title": "Spaghetti Carbonara",
  "category": "Pasta",
  "source": "Nonna Maria",
  "preparation_time": "30 Minuten",
  "ingredients": [
    {
      "group": "Hauptzutaten",
      "items": [
        { "quantity": 100, "unit": "g", "name": "Spaghetti", "department": "Grundnahrungsmittel" }
      ]
    }
  ],
  "spices": ["Salz", "Pfeffer"],
  "preparation": ["Schritt 1", "Schritt 2"],
  "tips": ["Tipp"],
  "kitchen_equipment": [{ "quantity": 1, "name": "Topf" }]
}
```

**Mengen-Konvention** (geändert ggü. Spec): Mengen sind angegeben **pro 1 Person**.
Skalierung im Frontend und in `einkaufsliste.php` multipliziert mit der
gewünschten Personenzahl direkt — kein `basis_personen`-Feld.

---

## 5. DE↔EN Übersetzung

### 5.1 Keys

`translation_map.json` Sektionen `de_to_en` / `en_to_de`:

| DE-Key            | EN-Key             |
|-------------------|--------------------|
| titel             | title              |
| kategorie         | category           |
| quelle            | source             |
| zubereitungszeit  | preparation_time   |
| zutaten           | ingredients        |
| gruppe            | group              |
| menge             | quantity           |
| einheit           | unit               |
| bezeichnung       | name               |
| abteilung         | department         |
| gewuerze          | spices             |
| zubereitung       | preparation        |
| tipps             | tips               |
| kuechenmaterial   | kitchen_equipment  |

**Bekannte Lücke**: für den inneren Array-Key `items` gibt es
**keine DE-Übersetzung**. Wer ein deutsches JSON hochlädt, muss
trotzdem `"items"` als Key für den inneren Zutaten-Array verwenden.
Wenn eine echte DE-Variante gewünscht wird, muss `translation_map.json`
um z. B. `"eintraege": "items"` erweitert werden.

**Wo die Übersetzung greift**: zentralisiert in
`api/translation.php` (`normalize_recipe()`), aufgerufen von
`upload.php` (POST) und `rezepte.php` (PUT). Eingehende Daten werden
rekursiv durchgegangen, bekannte DE-Keys werden auf EN umgesetzt;
unbekannte Keys bleiben unverändert.

### 5.2 Einheiten

**Erlaubte kanonische Einheiten** in der DB: `''` (leer), `g`, `ml`,
`Pck`, `Pcs`. Beim Upload und PUT werden eingehende Einheiten in diese
Form normalisiert. Match ist **case-insensitiv** — geprüft wird zuerst
auf exakten String-Match, dann gegen die Map mit
`strtolower`-Vergleich.

| Eingehend           | Kanonisch | Faktor auf `quantity` |
|---------------------|-----------|----------------------:|
| `g`, `ml`, `Pck`, `Pcs` (oder leer) | identisch | 1 |
| `kg`                | `g`       | × 1000               |
| `L`, `l`            | `ml`      | × 1000               |
| `EL`                | `g`       | × 15                 |
| `TL`                | `g`       | × 5                  |
| `Stück`, `Stueck`, `Stk` | `Pcs` | 1                    |
| `Packung`           | `Pck`     | 1                    |

**Alles andere** ⇒ HTTP 400 mit `{"error": "Einheiten-Fehler: Unbekannte Einheit \"X\" bei Zutat \"Y\""}` und Upload/PUT wird abgebrochen.

**Source of Truth** für die Mathematik: `unit_normalization_map()` in
`api/translation.php`. `translation_map.json` (`units_de_to_en` /
`units_en_to_de`) spiegelt nur die rein-wertbasierten Mappings
(`Stück↔Pcs`, `Packung↔Pck`) für Doku/Anzeige — wer dort etwas
ergänzt, muss auch die PHP-Map anpassen.

**Anzeige im Frontend**: `assets/units.js` (`displayUnit()`) zeigt
`Pcs` als „Stück" und `Pck` als „Packung". `g`/`ml` werden unverändert
angezeigt. Die DB hält immer die kanonische EN-Form.

### 5.3 Abteilungen (Department)

**Optionales Feld** auf jedem Ingredient-Item, dient nur dem Gruppieren
der Einkaufsliste. Wenn nicht gesetzt → in der Einkaufsliste unter
„Sonstiges" einsortiert.

**Erlaubte kanonische Werte** (case-insensitiv erkannt, beim Save in
kanonische Schreibweise normalisiert):

| Wert |
|---|
| `Obst/Gemüse` |
| `Frische Theke` |
| `Non-Food` |
| `Getränke` |
| `Backen` |
| `Grundnahrungsmittel` |

Unbekannte Werte ⇒ HTTP 400 mit `{"error": "Abteilungs-Fehler: Unbekannte Abteilung \"X\" bei Zutat \"Y\". Erlaubt: \"...\""}`.

**Source of Truth** für die Liste: `valid_departments()` in
`api/translation.php`. Erweitern: Konstante anpassen — danach
funktioniert es überall (Validation, Aggregation-Sort-Reihenfolge).

**Anzeige**: Die Einkaufslisten-Aggregation gruppiert nach Department.
Reihenfolge im Output entspricht der Listen-Reihenfolge oben
(`valid_departments()`), gefolgt von „Sonstiges" am Ende. Wenn ein
Department keine Zutaten enthält, wird es weggelassen.

**Konflikte beim Aggregieren**: Wenn dieselbe Zutat (gleicher
`name+unit`-Key) in zwei Rezepten unterschiedliche Departments hat,
gewinnt der erste nicht-leere Wert (first-seen). Praktisch sollte
das selten vorkommen — User pflegt Department-Klassifikation
konsistent.

---

## 6. API-Endpunkte

Alle Antworten sind JSON. Fehlerformat einheitlich: `{"error": "Beschreibung"}` mit passendem HTTP-Status.

### `GET /api/rezepte.php`

Liste aller Rezepte (ohne `daten`-Blob).

Query-Parameter:
- `?suche=<text>` — Volltextsuche auf `titel` (LIKE %x%)
- `?kategorie=<text>` — exakter Kategorie-Filter

```json
[
  { "id": 1, "titel": "…", "kategorie": "…", "quelle": "…",
    "zubereitungszeit": "…", "erstellt_am": "…" }
]
```

### `GET /api/rezepte.php/{id}`

Einzelnes Rezept inkl. komplettem `daten`-Blob (geparsed).

```json
{
  "id": 1, "titel": "…", "kategorie": "…", "quelle": "…",
  "zubereitungszeit": "…", "erstellt_am": "…",
  "daten": { /* vollständiges Rezept-JSON, EN-Keys */ }
}
```

`404 Not Found` falls ID nicht existiert.

### `PUT /api/rezepte.php/{id}`

Ersetzt ein Rezept komplett. Body: rohes Rezept-JSON (DE oder EN).
Validierung wie bei Upload (Pflichtfelder `title`/`titel` und
`ingredients`/`zutaten`). Aktualisiert `daten` und alle
denormalisierten Spalten.

```json
{ "success": true, "id": 1 }
```

`404` falls ID nicht existiert, `400` bei Validierungsfehlern,
`413` bei > 1 MB.

### `DELETE /api/rezepte.php/{id}`

Hartes Löschen. `404` falls ID nicht existiert.

```json
{ "success": true, "id": 1 }
```

### `POST /api/upload.php`

JSON-Upload, zwei Eingabemodi:
1. `multipart/form-data` mit Feld `datei`
2. Roh-JSON im Request-Body (`Content-Type` egal)

Max. 1 MB. Validierung: Pflichtfelder + Einheiten-Normalisierung (siehe Sektion 5.2). Bei unbekannter Einheit ⇒ 400 + Abbruch.

**Optional `dry_run=1`** als POST- oder GET-Parameter — führt komplette Validierung
+ Normalisierung + Kategorie-Existenzprüfung durch, **schreibt aber nichts** in die DB:

```json
{
  "ok": true,
  "warnings": [
    { "type": "new_category",
      "message": "Kategorie \"Backwaren\" existiert noch nicht — wird neu angelegt.",
      "category": "Backwaren" }
  ],
  "preview": { /* normalisiertes Rezept-JSON, kanonische Einheiten */ }
}
```

Echter Save (ohne `dry_run`), Antwort `201 Created`:

```json
{ "success": true, "id": 42, "warnings": [...] }
```

Das Frontend macht beim Datei-Pick automatisch erst einen `dry_run`,
zeigt das normalisierte Ergebnis + ggf. Warnungen, und sendet nur
nach Bestätigung den eigentlichen Save.

### `POST /api/einkaufsliste.php`

Body:

```json
{
  "rezepte": [ { "id": 1, "personen": 4 }, { "id": 2, "personen": 2 } ],
  "snapshot": { "1": { "daten": {...} } }
}
```

`snapshot` ist **optional**. Wenn vorhanden, wird für jede ID dort
nachgeschaut; nicht gefundene IDs fallen auf die `rezepte`-Tabelle
zurück. Damit kann der Client beim Aggregieren wahlweise den
gefrorenen Snapshot oder den Live-Stand verwenden (oder eine Mischung,
wenn neue Rezepte zum geladenen Snapshot hinzugefügt wurden).

Logik:
1. Rezepte zu den IDs aus DB laden (oder aus optionalem Snapshot, siehe 6.X)
2. Pro Rezept Mengen mit `personen / 1` multiplizieren (Basis = 1 Person)
3. Gleiche Items (Match auf `name` + `unit`, case-insensitive) **über
   alle Rezepte und alle Rezept-internen Gruppen hinweg** summieren.
   Die `group`-Information aus den Rezepten wird bewusst ignoriert —
   sie strukturiert das Kochen ("Teig", "Käse", "Hauptzutaten"), ist
   aber für den Einkauf irrelevant.
4. **Pro Department gruppieren** (siehe 5.3). Items mit gleichem name+unit
   merken sich das first-seen Department; Items ohne Department landen
   in „Sonstiges".
5. Innerhalb jedes Departments alphabetisch nach `name` sortieren;
   Departments in der kanonischen Reihenfolge aus `valid_departments()`,
   gefolgt von „Sonstiges" am Ende.

```json
{ "liste": [
  { "group": "Obst/Gemüse",
    "items": [{ "quantity": 200, "unit": "g", "name": "Tomate" }] },
  { "group": "Backen",
    "items": [
      { "quantity": 500, "unit": "g", "name": "Mehl" },
      { "quantity": 1,   "unit": "Pck", "name": "Hefe" }
    ] },
  { "group": "Sonstiges",
    "items": [{ "quantity": 100, "unit": "g", "name": "Butter" }] }
] }
```

Das Frontend rendert pro Eintrag einen `<h3>`-Header (Department-Name)
und eine `<ul>`-Liste mit den Items.

### `GET /api/cart.php`

Liefert die geteilte aktuelle Einkaufsliste (Singleton, von allen Nutzern
gemeinsam editiert) inklusive optionalem Recipe-Snapshot:

```json
{
  "items": [
    { "id": 3, "titel": "Spaghetti Carbonara", "personen": 4 }
  ],
  "snapshot": {
    "3": { "titel": "...", "kategorie": "...", "quelle": "...",
           "zubereitungszeit": "...", "daten": { /* full recipe */ } }
  },
  "updated_at": "2026-05-06 22:05:09"
}
```

`snapshot` ist `{}` wenn der Cart im Live-Modus läuft. Siehe Sektion 6.X
(Snapshot-Modus) für die Semantik.

### `PUT /api/cart.php`

Ersetzt items und snapshot. Body:

```json
{ "items": [{ "id": 3, "titel": "...", "personen": 4 }], "snapshot": {} }
```

Server sanitiziert items (nur `id`, `titel`, `personen`, `personen >= 1`,
Items ohne `id` verworfen); `snapshot` wird als opaque JSON-Object
gespeichert. Max. 1 MB.

**Race-Condition**: Last-Write-Wins. Mehrere parallel editierende Tabs
können sich gegenseitig überschreiben — für den Use-Case "kleiner
Haushalt teilt eine Liste" akzeptabel.

### `GET /api/saved_lists.php`

Listet alle benannten gespeicherten Listen (Metadata, ohne Items):

```json
{
  "listen": [
    { "name": "Wochenplan KW18", "gespeichert_am": "...", "count": 5 }
  ]
}
```

### `POST /api/saved_lists.php`

Speichert eine Liste unter einem Namen. Body: `{name, items}` — der
**Snapshot wird server-seitig automatisch aus der aktuellen
rezepte-Tabelle gebaut**. Der Client muss/darf den Snapshot nicht
mitschicken. Damit ist „save = freeze" garantiert konsistent.

Existiert der Name bereits → **Upsert** (überschreibt items + snapshot
+ gespeichert_am). Name max. 80 Zeichen, Body max. 1 MB.

```json
{ "success": true, "name": "Wochenplan KW18", "count": 2, "snapshot_size": 2 }
```

### `GET /api/saved_lists.php?name=<name>`

Lädt eine einzelne Liste **inklusive Snapshot**:

```json
{
  "name": "...",
  "gespeichert_am": "...",
  "items": [...],
  "snapshot": { "3": {...}, "6": {...} }
}
```

### `DELETE /api/saved_lists.php?name=<name>`

Löscht. `404` wenn nicht vorhanden.

```json
{ "success": true, "name": "..." }
```

### `GET /api/checks.php`

Liefert alle abgehakten Einträge, gruppiert nach Kategorie:

```json
{
  "zutaten":   ["mehl||g", "spaghetti||g"],
  "gewuerze":  ["salz||"],
  "equipment": []
}
```

Schlüssel-Format: `name_lower||unit_lower`. Für Gewürze und Equipment
(beide ohne Unit) ist der Teil nach `||` leer.

### `POST /api/checks.php`

Setzt oder entfernt ein einzelnes Häkchen. Body:

```json
{ "kategorie": "zutaten", "schluessel": "mehl||g", "checked": true }
```

`kategorie` muss `zutaten`/`gewuerze`/`equipment` sein, `schluessel`
muss non-empty sein. `checked: true` → INSERT, `false` → DELETE.

### `DELETE /api/checks.php[?kategorie=...]`

Ohne Parameter: löscht **alle** Häkchen. Mit `?kategorie=zutaten`:
nur die einer Kategorie.

### `GET /api/export.php`

Liefert die komplette Rezeptsammlung als JSON-Wrapper:

```json
{
  "exported_at": "2026-05-11T11:49:24+00:00",
  "version": 1,
  "count": 5,
  "recipes": [
    { /* full daten of rezept 1 — kanonisch, EN-Keys */ },
    ...
  ]
}
```

Antwort enthält den `Content-Disposition: attachment; filename="rezepte-export-YYYY-MM-DD.json"`-Header, damit der Browser bei
direkter Navigation einen Download-Dialog zeigt. JS-Clients dürfen den
ignorieren und den JSON-Body direkt verarbeiten.

### `POST /api/import.php`

Batch-Import. Akzeptiert beide Formate:
- **Wrapper**: `{recipes: [...]}` — passt direkt zum Export-Format
- **Bare array**: `[...]` — Liste von Rezept-Objekten

Eingabemodi wie bei `upload.php`: `multipart/form-data` mit Feld `datei`
oder Roh-JSON im Body. Max. 5 MB.

Per-Recipe-Validation (gleiche Logik wie Upload: Pflichtfelder,
Einheiten-Normalisierung, Department-Validierung). Defekte Einträge
werden gemeldet, der Rest wird trotzdem importiert.

Optional `dry_run=1` (POST- oder GET-Param): nur validieren, nichts
schreiben.

Antwort:

```json
{
  "total": 4,
  "imported": 2,
  "failed": [
    { "index": 2, "title": "...", "error": "Pflichtfeld \"ingredients\" fehlt" },
    { "index": 3, "title": "...", "error": "Einheiten-Fehler: ..." }
  ],
  "dry_run": false
}
```

### Method-Override

Falls Apache PUT/DELETE blockiert (z. B. restriktive Konfigs), akzeptiert
`rezepte.php` auch `POST` mit `X-HTTP-Method-Override: PUT|DELETE` oder
`?_method=PUT|DELETE`. Aktuell wird das vom Frontend nicht genutzt, ist
aber als Fallback vorhanden.

---

## 6.X Snapshot-Modus für gespeicherte Listen

**Problem**: Gespeicherte Listen speichern nur Rezept-IDs. Wenn ein
Rezept später bearbeitet (oder gelöscht) wird, würde die geladene
Liste andere Mengen/Inhalte produzieren als zum Speicherzeitpunkt.

**Lösung**: Beim Speichern wird zusätzlich ein **Snapshot** der
verlinkten Rezepte angelegt — eine Map `{rezept_id: {titel, kategorie,
quelle, zubereitungszeit, daten}}`, komplett aus der `rezepte`-Tabelle
abgegriffen. Beim Laden geht der Snapshot in den Cart-State; alle
nachfolgenden Aggregations- und Print-Operationen bevorzugen die
gefrorenen Daten.

**Lebenszyklus**:
1. **Speichern** (POST /api/saved_lists.php) → Server baut Snapshot aus
   aktueller `rezepte`-Tabelle für alle Cart-IDs. Client muss keinen
   Snapshot mitschicken.
2. **Laden** (GET /api/saved_lists.php?name=X) → Server liefert items +
   snapshot. Client setzt `cart.replaceAll(items, snapshot)`. Cart-PUT
   persistiert beides in `einkaufsliste_aktuell.snapshot`.
3. **Aggregieren / Drucken** → Client schickt Snapshot mit (oder nutzt
   ihn direkt im `loadCartRecipes`). Server bevorzugt Snapshot-`daten`
   vor `rezepte`-Tabelle-Lookup.
4. **Re-Speichern** (gleicher Name) → Server baut neuen Snapshot aus
   aktueller `rezepte`-Tabelle. Damit kann der User eine Liste
   bewusst „aktualisieren": load → re-save überschreibt den alten
   Snapshot.
5. **Snapshot verwerfen** (UI-Button im Banner) → `cart.replaceAll(
   cart.all(), {})` — items behalten, Snapshot leeren, Aggregation
   kommt wieder aus `rezepte`-Tabelle (Live-Modus).

**Mischbetrieb**: Wenn User nach dem Laden einer Liste manuell ein
neues Rezept hinzufügt, hat dieses keinen Snapshot-Eintrag. Die
Aggregation verwendet für alte Items den Snapshot, für neue die
Live-Daten — und unverändert für entfernte Items wird der
Snapshot-Eintrag automatisch verworfen (`cart.remove`).

**Größe**: Bis zu 1 MB pro Cart und pro gespeicherter Liste (siehe
`MAX_CART_BYTES` / `MAX_LIST_BYTES`). Ein Rezept mit normaler Komplexität
benötigt 2–5 KB → Platz für 200+ Rezepte pro Liste.

---

## 7. Apache-Routing (`.htaccess`)

```apache
RewriteEngine On

# /api/* direkt durch PHP — relatives Pattern (kein führender /),
# damit es im Root und in jedem Unterverzeichnis matcht.
RewriteRule ^api/ - [L]

# Statische Dateien direkt liefern
RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]

# Alles andere → SPA. index.php setzt <base> dynamisch.
RewriteRule ^ index.php [L]

php_value upload_max_filesize 2M
php_value post_max_size 2M
```

**Mount-Position-Unabhängigkeit**: Das Pattern `^api/` (ohne führenden
Slash) wird von mod_rewrite per-directory **relativ zur .htaccess-Position**
ausgewertet. Egal ob die App unter `/`, `/rezepte/`, `/foo/bar/` etc.
liegt — `^api/` matcht immer den lokalen `api/`-Ordner.

**Wichtig**: das `php_value` funktioniert nur mit `mod_php` (nicht
PHP-FPM). Wenn der Server auf FPM umgestellt wird, muss das in `php.ini`
oder per `SetEnv` umkonfiguriert werden.

## 7.1 Mount-Point-Unabhängigkeit (Subdirectory-Deployment)

Die App läuft unverändert in jedem Unterverzeichnis (z. B. `/rezepte/`,
`/apps/kueche/`). Drei Mechanismen sorgen dafür:

1. **`index.php` setzt `<base href="...">` dynamisch**:
   ```php
   $base = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\') . '/';
   ```
   Nach dem Apache-Rewrite zeigt `SCRIPT_NAME` auf `/<dir>/index.php`,
   `dirname` ergibt `/<dir>`, plus `/` ⇒ `/<dir>/`. Im Root wird daraus `/`.
   Alle relativen Pfade in HTML (`assets/style.css`, `<a href="upload">`)
   werden vom Browser gegen diesen `<base>` aufgelöst.

2. **`assets/config.js` exportiert `APP_BASE`**:
   ```js
   export const APP_BASE = new URL('../', import.meta.url).pathname;
   ```
   `import.meta.url` ist die volle URL des Moduls, z. B.
   `http://host/rezepte/assets/config.js`. `new URL('../', ...)` gibt das
   Parent-Verzeichnis ⇒ `/rezepte/`. Robust auch ohne `<base>`-Tag.

3. **Alle `data-link`-Hrefs sind base-relativ** (`href="upload"`, nicht
   `href="/upload"`). Der Browser löst sie gegen `<base>` auf; in Click-
   Handlern wird `link.pathname` (vom Browser bereits aufgelöst) gelesen.
   Der Router strippt `APP_BASE` von `location.pathname` vor dem
   Pattern-Matching:
   ```js
   function getRoutePath() {
       const p = location.pathname;
       const baseNoTrail = APP_BASE.replace(/\/$/, '');
       if (p === baseNoTrail || p === APP_BASE) return '/';
       if (p.startsWith(APP_BASE)) return '/' + p.slice(APP_BASE.length);
       return p;
   }
   ```

**PHP-Backend** ist von Haus aus mount-agnostisch: Pfade werden über
`__DIR__` aufgelöst, der Regex in `rezepte.php` für Pfad-IDs
(`#/api/rezepte(?:\.php)?/(\d+)$#`) matcht beide Varianten.

**Deployment**: einfach den Ordnerinhalt an die Zielposition kopieren.
Sicherstellen dass `data/` für Apache schreibbar ist und
`translation_map.json` lesbar (siehe Sektion 1). Keine weitere
Konfiguration nötig.

---

## 8. Frontend

### Router & State (`assets/app.js`)

Globaler State minimal — nur die Einkaufsliste, **server-backed** mit
lokalem Mirror:

```js
let cartState = {
    items: [],     // [{ id, titel, personen }]
    snapshot: {},  // {id: {titel, kategorie, quelle, zubereitungszeit, daten}}
};
```

**Sync-Strategie**:
- Beim App-Start: `await initCart()` holt den aktuellen Stand vom Server
  (`GET /api/cart.php`). One-time-migration: falls localStorage unter dem
  alten Key `rezepte.einkaufsliste.v1` Items hat und Server leer ist,
  wird gepusht. Danach wird der localStorage-Key gelöscht.
- Bei jedem `add`/`remove`/`setPersonen`/`clear`/`replaceAll`: optimistic
  update lokal + **debounced PUT** an den Server (300ms). Schnelle UI,
  Server bekommt nur einen Request pro Aktionsbündel.
- Beim Render der Einkaufslisten- und Print-Views: `await cart.refresh()`
  lädt erneut vom Server, damit Änderungen anderer User/Tabs sichtbar
  werden.

**Race-Condition**: Last-Write-Wins. Bewusst kein Lock, keine ETags. Für
den geplanten Use-Case (kleiner Personenkreis teilt eine Liste)
akzeptabel.

Cart-API (vom `cart`-Objekt exportiert):
`all()`, **`snapshot()`** (Map), `has(id)`, `add(rezept, personen)`,
`remove(id)`, `setPersonen(id, n)`, `clear()`,
**`replaceAll(items, snapshot)`** (für „Liste laden"), **`refresh()`**
(frisch vom Server holen).

Snapshot-Verhalten der Mutationen:
- `add` → Snapshot unverändert (neue Items sind nicht gefroren)
- `remove` → entfernt auch den orphaned Snapshot-Eintrag dieser ID
- `setPersonen` → Snapshot unverändert
- `clear` → Snapshot wird mitgeleert
- `replaceAll(items, snapshot)` → beide werden ersetzt

**Routes** (`pushState`-basiert, Patterns matchen in Reihenfolge —
spezifischere zuerst):

| Pattern                          | View                    |
|---------------------------------|-------------------------|
| `/`                              | Rezeptliste             |
| `/rezept/{id}`                   | Detail                  |
| `/rezept/{id}/bearbeiten`        | JSON-Editor             |
| `/upload`                        | Upload-View             |
| `/einkaufsliste`                 | Cart + Aggregations     |
| `/einkaufsliste/rezepte`         | Druck-Ansicht aller Cart-Rezepte |

Ein Klick auf `<a data-link href="…">` ruft `navigate(href)` auf,
das `pushState` macht und neu rendert. `popstate` wird gehört.

### Views

**`renderRezeptListe`** — Karten-Grid mit Live-Suche (debounced 200 ms)
und Kategorie-Filter. Kategorien werden beim ersten ungefilterten Load
befüllt.

**`renderRezeptDetail`** — Vollansicht mit Personen-Spinner. Mengen
werden im Frontend live skaliert. Buttons:
- "+ Zur Einkaufsliste" (oder "Personen aktualisieren" wenn schon im Cart)
- "✎ Bearbeiten" → `/rezept/{id}/bearbeiten`
- "💾 Als JSON" → Download des `daten`-Blobs als `<titel>.json` (client-seitig, kein Server-Roundtrip). Datei ist re-importierbar via Upload/Import.
- "🗑 Löschen" → Confirm + `DELETE` + Cart-Cleanup + Navigation auf `/`

**`renderRezeptEdit`** — Textarea mit aktuellem JSON, Speichern/Reset/
Abbrechen. Beim Speichern wird `cart`-Eintrag mit aktualisiertem Titel
neu eingetragen, falls das Rezept dort liegt.

**`renderUpload`** — Drag&Drop oder File-Picker. Header-Hinweise:
(1) Download-Link auf `recipe_template.json` (base-relativ, mit
`download`-Attribut → direkter Filesystem-Download statt Browser-
Anzeige). (2) Beispiel-KI-Prompt zur Rezept-Extraktion aus Webseiten,
mit Copy-to-Clipboard-Button.

Unten klappbarer Bereich „**📦 Komplette Sammlung verwalten**":
- **Export**: einfacher `<a href="api/export.php" download>` — Browser
  triggert Download direkt, kein JS nötig.
- **Import**: File-Input + zwei Buttons („🔍 Prüfen (dry-run)" und
  „📥 Importieren"). Aufruf von `api.importCollection(file, {dryRun})`
  → Server validiert per-recipe → Antwort wird als „X von Y importiert"
  plus aufklappbare Fehlerliste angezeigt.

Nach Auswahl einer Einzeldatei wird **automatisch ein
dry-run** an `/api/upload.php?dry_run=1` geschickt;
das normalisierte Rezept wird mit `displayUnit()`-übersetzten
Einheiten angezeigt. Warnungen (z. B. neue Kategorie) erscheinen in
einer gelben Box mit Hinweis „Du kannst trotzdem speichern". Erst
**Speichern** löst den echten Insert aus; **Abbrechen** verwirft alles.
Bei Einheiten-Fehlern erscheint nur die Fehlermeldung — kein
Speichern-Button.

**`renderEinkaufsliste`** — beim Render `await cart.refresh()` +
`refreshSavedLists()` (Server-State frisch holen). Drei Bereiche:

1. **Gespeicherte Listen** (`<details>`-Sektion oben, default-open wenn
   Listen vorhanden): Tabelle Name / Anzahl / Datum mit `📂 Laden` und
   `🗑` pro Zeile. „Laden" replaceAll-t den Cart (mit Confirm wenn der
   aktuelle nicht leer ist).
2. **Aktuelle Auswahl**: Cart-Tabelle wie bisher + „Speichern als"-Input
   mit Confirm-Dialog beim Überschreiben eines bestehenden Namens.
3. **Output-Buttons** für Aggregationen:

| Button | Quelle | Logik | Export |
|---|---|---|---|
| Zutaten | `POST /api/einkaufsliste.php` | Skalierung pro Personen, gleiche `name`+`unit` über alle Rezepte und Rezept-Gruppen hinweg summieren — flache Liste (Rezept-`group` wird ignoriert, sie ist Koch-, keine Einkaufs-Struktur) | Copy / `einkaufsliste.txt` |
| Gewürze | Client-Aggregation aus `daten.spices` aller Cart-Rezepte | Union, case-insensitive Dedup, alphabetisch | Copy / `gewuerze.txt` |
| Küchenausstattung | Client-Aggregation aus `daten.kitchen_equipment` | Union nach `name` (case-insensitive); Quantity ist **Maximum** über Rezepte (kein Aufsummieren — Geräte werden wiederverwendet) | Copy / `kuechenausstattung.txt` |
| Komplette Rezepte | Lädt alle Cart-Rezepte (`loadCartRecipes`) und rendert sie inline mit `renderRezeptHtml` (skaliert nach Personenzahl) | Drucken/PDF (`window.print()`) / `rezepte.txt` |

Das Ergebnis wird in einem gemeinsamen `<div id="ergebnis">` Bereich
gerendert — jeder Klick ersetzt den Inhalt. Geladene Volldaten werden
zwischen den Buttons gecached (bis Personenzahl geändert oder Rezept
entfernt wird).

**Abgehakt-Persistenz** (server-side, geteilt zwischen Nutzern): Jede
Liste (Zutaten/Gewürze/Equipment) hat in der DB einen Eintrag pro
abgehakter Position. Schlüssel ist `name_lower||unit_lower` — kein
quantity, kein group, damit der Check über Personenzahl-Änderungen
hinweg erhalten bleibt. Beim Render werden Daten und Checks parallel
geholt (`Promise.all`). Toggle einer Checkbox → optimistic local
update + `POST /api/checks.php` im Hintergrund (Fehler werden nur
geloggt, nicht reverted). Jede Sektion hat einen
"↺ Häkchen zurücksetzen"-Button (DELETE pro Kategorie). Beim "Alle
entfernen" und beim Laden einer gespeicherten Liste werden **alle**
Häkchen gelöscht (neuer Einkaufszyklus).

**Print-Verhalten**: Cart-Tabelle und Toolbar sind mit `.no-print`
markiert. Wenn der Benutzer auf der Einkaufsliste-Seite "🖨 Drucken"
klickt während der Rezept-Ansicht, blendet die Print-CSS Header,
Footer, Cart-Tabelle, alle Action-Buttons und das `h2` aus — gedruckt
wird nur die Rezeptsammlung selbst, mit Seitenumbruch zwischen
Rezepten.

**`renderRezeptePrint`** (Route `/einkaufsliste/rezepte`) — Standalone-
Vollansicht; nutzt dieselben Helper (`loadCartRecipes`,
`renderRezeptHtml`, `downloadRecipesAsText`). Wird vom Hauptflow nicht
mehr verlinkt, ist aber als Direkt-URL erreichbar (z. B. für Bookmarks).

### Fetch-Wrapper (`assets/api.js`)

Methoden:
- `listRezepte({ suche, kategorie })`
- `getRezept(id)`
- `uploadRezept(file, { dryRun })` / `uploadRezeptJson(obj, { dryRun })`
- `updateRezept(id, json)` (PUT)
- `deleteRezept(id)` (DELETE)
- `einkaufsliste(rezepte)`

Fehlerformat aus dem Server (`{"error": "…"}`) wird in `Error` übersetzt.

---

## 9. Konventionen

### PHP

- `declare(strict_types=1);` in jeder Datei
- Helper `json_response($data)` und `json_error($msg, $status)` aus
  `bootstrap.php` — beide rufen `exit;` auf (Return-Type `: never`)
- `set_exception_handler` in `bootstrap.php` fängt nicht-erwartete
  Exceptions und gibt `500 + {"error":"Server error: …"}` zurück
- Übersetzungs- und Validierungslogik **nicht in Endpunkte kopieren** —
  immer `normalize_recipe()` aus `translation.php` nutzen

### JavaScript

- Vanilla ES-Modules, keine Frameworks
- HTML-Strings via Template-Literals; **immer `escapeHtml()` für
  user-stämmige Daten** (lokale Helper in jeder View)
- Keine `innerHTML`-Manipulation auf Container-Elementen, die schon
  Event-Listener haben — stattdessen die ganze View neu rendern (siehe
  `renderEinkaufsliste`'s `draw()`)

---

## 10. Bekannte Stolpersteine

| Symptom | Ursache | Fix |
|---|---|---|
| `500 — could not find driver` | `pdo_sqlite` fehlt | `apt install php-sqlite3` |
| `500 — json_decode(): … false given` beim Upload | `translation_map.json` für `www-data` nicht lesbar | `chmod 644 translation_map.json` |
| `404` auf `/rezept/1`, `/upload` etc. | `.htaccess` wird nicht ausgewertet | `AllowOverride All` für `/var/www/` setzen |
| `500 — undefined function mb_strtolower()` | `mbstring` fehlt | bereits per Fallback auf `strtolower()` abgefangen — `mbstring` ist optional |
| `unable to open database file` ODER `attempt to write a readonly database` | `data/` nicht beschreibbar für Apache. Letztere Meldung ist trügerisch: SQLite meint nicht die DB-Datei sondern das Verzeichnis (für die Journal-Datei `*.db-journal` / `-wal` / `-shm`). | `sudo chown -R www-data:www-data data/ && sudo chmod 775 data/`. Häufig nach Deploy als non-Apache-User: Apache kann beim ersten Request die DB anlegen (Journal initial nicht nötig), aber spätere Writes brauchen Verzeichnisrechte. |
| Detail-Endpunkt liefert Liste statt Einzel-Rezept | Pfad-Regex matcht nicht | aktueller Regex matcht `/api/rezepte/{id}` UND `/api/rezepte.php/{id}` |
| Cart enthält gelöschtes Rezept | Cart wird auf Server-Seite nicht synchronisiert | Frontend ruft `cart.remove()` nach `DELETE` auf — bei direkten DB-Eingriffen muss man im Browser localStorage manuell leeren |
| Upload bricht mit "Unbekannte Einheit" ab | Einheit ist nicht in der Map (siehe 5.2) | Entweder JSON anpassen (z. B. `Stk` → `Stück`), oder `unit_normalization_map()` in `api/translation.php` ergänzen + ggf. `translation_map.json` aktualisieren |
| Upload bricht mit "Unbekannte Abteilung" ab | `department`-Wert nicht in der Liste (siehe 5.3) | JSON anpassen auf einen der erlaubten Werte (Obst/Gemüse, Frische Theke, Non-Food, Getränke, Backen, Grundnahrungsmittel) oder die Liste in `valid_departments()` erweitern |

---

## 10.X Security-Modell

### Bedrohungsmodell und bewusste Designentscheidungen

Die App ist konzipiert für ein **vertrauliches LAN-/Single-Household-
Setup** ohne User-Verwaltung. Daraus ergeben sich die Designentscheidungen:

- **Keine Authentifizierung**: jeder mit Netzwerk-Zugriff auf den Host
  hat vollen Lese- und Schreibzugriff. Wer dieselbe URL erreicht, kann
  alle Rezepte und Listen sehen und bearbeiten.
- **Geteilter Zustand**: Cart, Saved-Lists, Checks sind ein Singleton —
  keine Trennung „mein vs. fremd". Daher kein IDOR-Vektor im klassischen
  Sinn (es gibt keine Owner-Beziehung zwischen Ressourcen und Nutzern).
- **Plain HTTP per Default**: HTTPS ist Deployment-Sache (Reverse-Proxy
  vor Apache). Wer die App im Internet hostet, MUSS HTTPS und zusätzlich
  Authentifizierung vorlagern.

### Implementierte Härtung (defense in depth)

| Bereich | Maßnahme | Stelle |
|---|---|---|
| **Direkter File-Zugriff** | `.htaccess` blockt `data/`, `*.db`, `*.sqlite`, `*-journal`, `.ht*`, `.git*` mit `[F,L]` (403). | `.htaccess` |
| **CSRF** | Cross-Origin-POST/PUT/DELETE wird abgelehnt (403) — Origin/Referer-Header müssen zum eigenen Host passen. Browser senden diese immer; curl/Tools ohne Origin werden durchgelassen weil sie kein CSRF-Vektor sind. | `ensure_same_origin()` in `bootstrap.php` |
| **CORS** | Keine `Access-Control-Allow-*` Header → keine Cross-Origin-Zugriffe möglich. Same-Origin braucht kein CORS. | `bootstrap.php` |
| **XSS** | Alle User-/DB-Daten durchlaufen `escapeHtml()` vor `innerHTML`-Insertion. CSP `script-src 'self'` blockt Inline-Scripts und externe Skripte. `X-Content-Type-Options: nosniff` verhindert MIME-Sniffing. | Frontend-Views + `.htaccess` CSP |
| **Clickjacking** | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` — die App kann nicht in iframes geladen werden. | `.htaccess` + `bootstrap.php` |
| **SQL Injection** | Alle User-Input-Queries nutzen PDO-Prepared-Statements mit Named/Positional Parameters. `$db->exec()` wird nur für hardcoded DDL/DML ohne User-Input genutzt. | alle `api/*.php` |
| **Path Traversal** | Filesystem-Pfade sind hardcoded via `__DIR__`. User-Uploads landen in PHP-kontrolliertem `tmp_name`. | `bootstrap.php`, `upload.php` |
| **Input-Validation** | Alle Free-Text-Felder durchlaufen `sanitize_text()`: NULL-Bytes + C0-Controls gestripped, Längen-Limits (siehe Konstanten in `translation.php`). Einheiten und Departments werden gegen Whitelist validiert. | `translation.php`, `cart.php`, `saved_lists.php` |
| **DoS** | Größen-Limits: Upload 1 MB, Import 5 MB, Cart 1 MB, Saved-Listen 1 MB, max 200 Cart-Items. | jeweils pro Endpoint |
| **Error-Leaking** | `set_exception_handler` gibt generische „Internal server error"-Meldung. Details (Klasse, Datei, Zeile, Message) gehen nur ins `error_log`. | `bootstrap.php` |
| **Information Disclosure** | Server-Signature-Reduktion ist Apache-Hauptconfig-Sache (`ServerTokens Prod`, `ServerSignature Off` in `apache2.conf`) — kann nicht in `.htaccess` gesetzt werden. | Deployment |
| **Referrer-Leak** | `Referrer-Policy: same-origin` — keine Referer-Info an Drittseiten beim Folgen externer Links (haben wir aktuell zwar nicht, defense-in-depth). | `.htaccess` + `bootstrap.php` |

### Was bewusst NICHT implementiert ist

- **Authentifizierung / Sessions**: würde das geteilte Verwendungsmodell
  brechen (mehrere Family-Members editieren denselben Cart). Wer Auth
  braucht, packt nginx-basic-auth oder ein Reverse-Proxy mit OAuth davor.
- **Rate-Limiting**: kein App-internes Throttling. Apache-Module wie
  `mod_evasive` oder `fail2ban` können das von außen liefern.
- **Audit-Log**: wer wann was geändert hat, wird nicht erfasst. Apache-
  Access-Log enthält die HTTP-Requests aber keine Bodies.
- **Encrypted-at-Rest**: SQLite-Datei ist Plain. Auf gemeinsam genutzten
  Hosts: Filesystem-Permissions sicherstellen (`chmod 640`,
  `chown www-data:www-data`).

### Production-Checkliste

Wer die App im Internet (statt LAN) betreibt:

1. **HTTPS aktivieren** — Reverse-Proxy (Caddy, nginx, Apache vhost) mit
   Let's Encrypt davor. In `.htaccess` dann `Strict-Transport-Security`
   uncomenten.
2. **Authentifizierung vorlagern** — z. B. nginx `auth_basic`, oauth2-
   proxy, Authelia. Die App selbst kennt keine User.
3. **`mod_headers` aktivieren** (`a2enmod headers`), damit die CSP- und
   Sicherheits-Header aus der `.htaccess` greifen — die PHP-Antworten
   sind durch `bootstrap.php` ohnehin gehärtet, aber statische Files
   profitieren erst dann.
4. **`ServerTokens Prod` und `ServerSignature Off`** in
   `/etc/apache2/conf-enabled/security.conf` — versteckt die Apache-
   Version.
5. **`AllowOverride All`** für den App-Pfad ist Pflicht — sonst greift
   die `.htaccess` nicht (siehe Sektion 7).
6. **Filesystem-Permissions**: `data/` 770 (`www-data` als Owner),
   `translation_map.json` 644, kein Read-Zugriff für `other`.
7. **Kein `phpinfo.php`** im Web-Root — leakt Server-Internals.
8. **Periodisches Backup** der `data/rezepte.db` (oder via Export-API).

---

## 11. Erweiterungsideen (offen)

- **Form-basierter Editor** statt Textarea (Felder pro Zutat, Drag-Sort
  von Zubereitungs-Schritten)
- **Bilder pro Rezept** — neue Spalte + Upload-Endpunkt + Static-Serving
- **Volltextsuche auch über Zutaten** — JSON1-Funktionen in SQLite
  (`json_extract(daten, '$.ingredients...')`)
- **Tags / Mehrfach-Kategorien** — neue Tabelle `rezept_tags` (n:m)
- **Authentifizierung** — momentan steht alles offen, fürs LAN kein
  Problem, für Internet-Hosting Pflicht
- **DE-Key für `items`** in `translation_map.json` ergänzen
- **Importer** für Standard-Formate (Schema.org/Recipe, Mealie-Export)

---

## 12. Changelog

### 2026-05-04 — initiale Implementierung

- Backend: `bootstrap.php`, `rezepte.php` (nur GET), `upload.php`, `einkaufsliste.php`
- Frontend: SPA mit Liste, Detail, Upload, Einkaufsliste
- DE→EN Übersetzung beim Upload
- Skalierung pro 1 Person als Basis (Spec war ambivalent)

### 2026-05-04 — Stabilisierung

- `load_translation_map()` hardened gegen unlesbare/kaputte Mapping-Datei
- Pfad-Regex in `rezepte.php` matcht jetzt `/api/rezepte/{id}` und `/api/rezepte.php/{id}`
- `mb_strtolower`-Fallback auf `strtolower` in `einkaufsliste.php`
- Apache: `AllowOverride All` als Setup-Schritt dokumentiert
- Datei-Permissions für JSON-Konfigs auf `644` korrigiert

### 2026-05-12 — PWA-Phase 3: Offline-UI

- Neuer Offline-Banner im `index.php`-Header (`<div class="offline-banner">`), per CSS standardmäßig hidden, sichtbar wenn `<body>` die Klasse `is-offline` hat.
- `assets/app.js` setzt `body.is-offline` aus `navigator.onLine` und reagiert auf die `online`/`offline`-Events. Plus neuer Export `network.isOnline()` falls Views ihn brauchen.
- CSS-Regel `body.is-offline .needs-network { opacity:0.45; pointer-events:none; cursor:not-allowed; filter:grayscale(0.4); }` — alle Actions die offline echt nichts können sind mit `needs-network` markiert und werden im Offline-Modus sichtbar gedämpft + klickresistent.
- Markiert mit `needs-network`: Upload-Save, Bulk-Dry-Run, Bulk-Import, Detail-Bearbeiten, Detail-Löschen, Edit-Speichern, Einkaufsliste-„Speichern als", Saved-Lists-Laden, Saved-Lists-Löschen, „Häkchen zurücksetzen".
- **Nicht** markiert (Local-first, Phase 4 macht sie persistent): Cart-Items-Entfernen, Cart-„Alle entfernen", Personenzahl ändern, Häkchen-Toggle. Diese Aktionen ändern lokalen State, der debounced-PUT-Cart-Sync failed offline silent — beim nächsten Online-Wechsel wird automatisch gesynct (vorhandene `scheduleCartSave`-Logik).
- Banner-Text: „Offline — Anzeigen geht, Änderungen am Server bis zur nächsten Verbindung deaktiviert". Mit role=status + aria-live=polite für Screen-Reader.

### 2026-05-12 — PWA-Phase 2 Fix: offline Zutaten/Gewürze/Equipment

Bug-Report von Live-Test: Offline klappt „Komplette Rezepte", aber bei
„Zutaten" / „Gewürze" / „Küchenausstattung" kam „Fehler: offline".

Ursache: die drei Aggregations-Handler haben `loadRecipes()` und
`api.getChecks()` parallel via `Promise.all` geholt. Wenn der User die
Einkaufsliste vorher noch nie online besucht hatte, war
`/api/checks.php` nicht im SW-Cache → der SW lieferte den 503-Offline-
Fallback → `Promise.all` rejected → ganze View kippt obwohl die Rezept-
Daten aus dem Snapshot vorhanden wären.

Fix: kleiner Helper `safeGetChecks()` in `views/einkaufsliste.js` —
wenn der API-Call fehlschlägt (offline oder echter Server-Fehler),
gibt er `{zutaten:[],gewuerze:[],equipment:[]}` zurück und loggt eine
warning, statt das Render zu blockieren. Alle drei Generate-Funktionen
nutzen den Wrapper.

Side-effect: offline gesetzte Häkchen werden weiterhin im DOM
gehalten aber nicht persistiert — der `wireCheckboxes`-Toggle ruft
`api.setCheck()`, das offline failed. Das wird sauber von Phase 4
(IndexedDB-Queue + Background-Sync) gelöst. Bis dahin: console.error,
DOM-State bleibt, beim nächsten Online-Reload sieht der User den
Server-Stand.

### 2026-05-11 — PWA-Phase 2: Manifest + Service Worker

Die App ist ab jetzt eine installierbare Progressive Web App.

- Neu: `manifest.webmanifest` mit name, theme/background-color, icons in SVG + PNG-Größen (192/512/maskable), display:standalone, start_url/scope base-relativ
- Neu: `sw.js` im App-Root mit drei Cache-Strategien:
  - **Navigation** (HTML) → Network-first, App-Shell-Fallback bei Offline
  - **Statische Assets** (`assets/*`) → Cache-First
  - **API-GETs** (`api/*`) → Stale-While-Revalidate
  - POST/PUT/DELETE und cross-origin Requests werden transparent durchgereicht
  - `CACHE_VERSION`-Konstante steuert das Cache-Lifecycle; alte Caches werden beim `activate`-Event aufgeräumt
- Neu: `assets/icons/icon.svg` (Vektor, Kochtopf-Motiv in Accent-Farbe) plus PNG-Placeholder in den Standard-Größen. **Placeholders sind einfarbige Blöcke** — für Production-Polish durch echte Designs ersetzen.
- Geändert: `index.php` mit manifest-Link, `theme-color`, iOS-Meta-Tags (`apple-mobile-web-app-capable`, status-bar-style, apple-touch-icon, viewport-fit=cover für Notch-Geräte)
- Geändert: `assets/app.js` registriert den SW mit Mount-Point-aware Scope (`APP_BASE + 'sw.js'`)
- Geändert: `.htaccess` mit MIME-Type für `.webmanifest` und `Cache-Control: no-cache` für `sw.js` (damit Updates schnell durchschlagen; braucht `mod_headers`)
- Smoke-Test: Manifest valides JSON mit korrektem Content-Type, alle 5 Icon-Größen 200, alle PWA-Meta-Tags im DOM, SW-Registration im app.js
- **Bekannte Einschränkung**: PNG-Icons sind 1×1 hochskalierte einfarbige Placeholders. Funktioniert technisch, sieht aber kacke aus. Echte Icons (z. B. exportiert aus dem SVG via Inkscape oder Online-Tool) kommen als nächstes.

### 2026-05-11 — PWA-Phase 1: Aggregation client-seitig

Vorarbeit für den Offline-Modus: die Zutaten-Aggregation wandert vom
Server-Endpoint `api/einkaufsliste.php` als JS-Modul ins Frontend.

- Neue Datei `assets/aggregate.js` mit `aggregateIngredients(recipes)`,
  `aggregateSpices(recipes)`, `aggregateEquipment(recipes)`. Letztere beiden
  waren bereits client-seitig in `views/einkaufsliste.js` — wurden in das
  neue Modul übersiedelt, damit alle Aggregations-Funktionen an einem Ort
  liegen.
- `aggregateIngredients` ist 1:1-Portierung der PHP-Logik aus
  `api/einkaufsliste.php`: Aggregations-Key `name_lower||unit_lower`,
  first-seen Department gewinnt (mit „leer → nicht leer"-Aufwertung),
  Department-Reihenfolge folgt `VALID_DEPARTMENTS`, „Sonstiges" am Ende.
- `views/einkaufsliste.js` ruft nicht mehr `api.einkaufsliste()` auf;
  stattdessen `loadRecipes()` + `aggregateIngredients(recipes)`. Bei
  aktivem Snapshot zero API-Calls für die Aggregation, sonst nur die
  per-Rezept-`getRezept()`-Aufrufe (die in Phase 2 vom Service Worker
  gecached werden).
- `api/einkaufsliste.php` bleibt aus Kompatibilitätsgründen erhalten —
  wird vom Frontend aber nicht mehr genutzt. Kann später entfernt
  werden falls externe Konsumenten keine Rolle spielen.
- Smoke-Test: Server- und Client-Aggregation liefern bit-identisches
  Output über mehrere Test-Szenarien (1 Rezept mit allen Departments,
  2 Rezepte mit überlappenden Items, mixed-department-merge).

### 2026-05-11 — Security-Härtung

Mehrere Schichten Hardening gegen die einschlägigen OWASP-Top-10-Vektoren:

- **Direkter File-Zugriff blockiert** (vorher kritisch!): `.htaccess`
  liefert 403 für `data/`, alle `*.db`/`*.sqlite`/`*-journal`/`-wal`/
  `-shm`-Files, `.ht*` und `.git*`. Vorher war `data/rezepte.db`
  über HTTP komplett downloadbar.
- **Security-Headers**: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`. Plus eine
  strikte `Content-Security-Policy` mit `script-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'`. Headers werden vom
  PHP-Backend für API-Antworten gesetzt; statische Files brauchen
  `mod_headers` in Apache.
- **CSRF-Schutz**: `ensure_same_origin()` in `bootstrap.php` blockt
  POST/PUT/DELETE wenn Origin/Referer nicht zum eigenen Host passt.
  Tools ohne Origin/Referer (curl) bleiben erlaubt — die sind kein
  CSRF-Vektor.
- **CORS-Wildcard entfernt**: vorher `Access-Control-Allow-Origin: *`,
  jetzt gar nicht mehr gesetzt. Same-Origin braucht kein CORS.
- **Generic Error-Response**: `set_exception_handler` gibt jetzt nur
  `{"error":"Internal server error"}` an den Client zurück. Details
  (Class, File, Line, Message) gehen ausschließlich ins `error_log`.
- **Input-Sanitisierung**: neue `sanitize_text()` in `translation.php`
  entfernt NULL-Bytes und C0-Controls, trimmt auf max-Längen-Konstanten
  (`MAX_TITLE_LEN=200`, `MAX_INGREDIENT_NAME=200`, `MAX_PREP_STEP_LEN=5000`
  etc.). Wird auf alle Free-Text-Felder im Recipe-Upload angewendet.
- **Cart-Bombing-Schutz**: `MAX_CART_ITEMS=200` und `MAX_CART_TITEL_LEN=200`
  in `cart.php` und `saved_lists.php`.
- **XSS-Audit**: bestehende `escapeHtml`-Nutzung in allen Views
  verifiziert — gemixter HTML-Payload (`<script>`, `<img onerror>`,
  `<svg onload>`) im Recipe-Titel/Name/Group/Prep wird sauber zu
  HTML-Entities encoded. Keine roh-injected DOM-Pfade.
- **Doku**: neue Sektion 10.X „Security-Modell" mit Bedrohungsmodell,
  Maßnahmen-Tabelle, was bewusst NICHT geschützt ist (z. B. Auth)
  und Production-Checkliste für Internet-Deployment.

### 2026-05-11 — KI-Prompt erweitert: 1-Personen-Normierung + Departments

- Beispiel-Prompt auf der Upload-Seite (in der `prompt-box`) ist jetzt deutlich präziser: weist die KI explizit an, alle Zutaten-Mengen auf 1 Person zu normieren (passt zur App-Konvention) und ein optionales `department` aus der erlaubten Liste zu setzen. Erwähnt auch welche Einheiten erlaubt sind (inkl. auto-normalisierbarer Aliase wie kg/L/EL/TL).
- Frühere Version war ein One-Liner ohne diese Hinweise — Resultate wurden oft für 4 Personen geliefert und mussten manuell geteilt werden.

### 2026-05-11 — JSON-Export für einzelne Rezepte + Export/Import der Sammlung

- **Single-Recipe-Export**: Detail-View bekommt „💾 Als JSON"-Button. Lädt das `daten`-JSON client-seitig als `<titel>.json` herunter (kein Server-Endpunkt nötig). Datei ist re-importierbar via Upload oder Batch-Import.
- **Collection-Export**: neuer `api/export.php` GET — liefert `{exported_at, version, count, recipes: []}`-Wrapper aller Rezepte. `Content-Disposition: attachment` für direkten Browser-Download.
- **Collection-Import**: neuer `api/import.php` POST. Akzeptiert Wrapper-Format oder bare Array. Per-recipe-Validation (`normalize_recipe_strict` wirft `RecipeValidationException` statt zu exiten — neu refactored). Defekte Einträge werden als `{index, title, error}` gemeldet, der Rest wird trotzdem importiert (partial success). Optional `dry_run=1` für reine Prüfung. Max. 5 MB.
- `translation.php`: `normalize_recipe()` ist jetzt ein dünner Wrapper um `normalize_recipe_strict()`, der die Exception in den bestehenden `json_error`-Flow übersetzt. Single-Request-Endpunkte (upload, PUT) bleiben unverändert kompatibel.
- Upload-View hat unten eine klappbare Sektion „📦 Komplette Sammlung verwalten" mit Export-Link und Batch-Import-UI (File-Input + Prüfen/Import-Buttons + Fehlerliste).

### 2026-05-06 — Department/Abteilung für Ingredient-Items

- Neues optionales Feld `department` (DE: `abteilung`) auf jedem Ingredient-Item. Erlaubte Werte: `Obst/Gemüse`, `Frische Theke`, `Non-Food`, `Getränke`, `Backen`, `Grundnahrungsmittel`. Match case-insensitiv, beim Save kanonisch normalisiert. Unbekannter Wert → HTTP 400.
- `translation_map.json`: `abteilung↔department` ergänzt.
- `api/translation.php`: neue `valid_departments()`, `normalize_single_department()`, `normalize_departments_in_recipe()`. In `normalize_recipe()` integriert.
- `api/einkaufsliste.php`: Aggregation gruppiert jetzt nach Department. Items ohne Department landen in „Sonstiges". Department-Reihenfolge im Output entspricht `valid_departments()`, gefolgt von „Sonstiges". Wenn dieselbe Zutat in zwei Rezepten unterschiedliche Departments hat, gewinnt first-seen.
- `recipe_template.json`: leeres `department`-Feld als Beispiel.
- Upload-Vorschau (`views/upload.js`): zeigt jetzt einen kleinen Tag `<span class="dept-tag">` mit dem Department neben dem Item-Namen.
- Bestehende gespeicherte Listen / Snapshots ohne `department` funktionieren weiterhin — alle Items landen in „Sonstiges" bis sie nach-bearbeitet werden.

### 2026-05-06 — Snapshot-Modus für gespeicherte Listen

- **Problem-Fix**: Gespeicherte Listen referenzierten nur Rezept-IDs — wenn ein Rezept später bearbeitet/gelöscht wurde, änderte sich auch die geladene Liste retroaktiv. Mit Snapshot-Modus ist die Liste eingefroren = unabhängig von späteren Änderungen.
- Schema-Erweiterung: `snapshot` TEXT-Spalte (JSON) in `einkaufsliste_aktuell` und `einkaufsliste_gespeichert`. Idempotente Migration via PRAGMA table_info-Check in bootstrap.php — fügt die Spalte für bestehende DBs nach.
- Beim **Speichern** baut der Server den Snapshot automatisch aus der aktuellen `rezepte`-Tabelle. Client schickt nur `{name, items}`.
- Beim **Laden** flowt der Snapshot in den Cart-State. `cart.replaceAll(items, snapshot)` persistiert ihn auch im geteilten `einkaufsliste_aktuell.snapshot`.
- `einkaufsliste.php` (Aggregation) akzeptiert optionalen `snapshot`-Param und bevorzugt diese Daten gegenüber der DB. `rezepte_print.js` `loadCartRecipes` nutzt Snapshot-Daten direkt statt `getRezept` zu callen wenn vorhanden.
- UI: Blaues 📸-Banner oben in der Einkaufsliste-View signalisiert aktiven Snapshot, plus „Snapshot verwerfen"-Button (Items behalten, Snapshot leeren → zurück zu Live-Modus).
- **Mischbetrieb**: Nach Load-Snapshot manuell hinzugefügte Rezepte landen ohne Snapshot-Eintrag. Aggregation nutzt Snapshot für alte, Live-Daten für neue Items.
- MAX_CART_BYTES und MAX_LIST_BYTES auf 1 MB hochgesetzt (Snapshot kann groß werden — ~5KB pro Rezept × 200 Rezepte Headroom).

### 2026-05-06 — Abgehakt-Status server-seitig persistent

- Neue Tabelle `einkaufsliste_abgehakt` (composite PK `kategorie`+`schluessel`) hält geteilte Häkchen für Zutaten/Gewürze/Equipment
- Schlüssel-Format `name_lower||unit_lower` — bewusst ohne quantity, damit Personenzahl-Änderungen den Check **nicht** verwerfen
- Neuer Endpoint `api/checks.php`: GET (alle, gruppiert), POST (toggle einzelnes), DELETE (clear alle bzw. per kategorie)
- Frontend: jede Sektion (Zutaten/Gewürze/Equipment) lädt Daten und Checks parallel via `Promise.all`. Checkboxes haben `data-kategorie`+`data-schluessel`-Attribute; ein delegierter Toggle-Handler synct optimistic an den Server. „↺ Häkchen zurücksetzen"-Button pro Sektion.
- Beim „Alle entfernen" (Cart leeren) und „Liste laden" (replaceAll) werden auch alle Häkchen geleert — neuer Einkaufszyklus, fresh start

### 2026-05-06 — Einkaufsliste server-backed + benannte gespeicherte Listen

- **Cart ist jetzt geteilt**: Aktuelle Einkaufsliste wird serverseitig in der neuen Tabelle `einkaufsliste_aktuell` (Singleton, eine Zeile) gehalten. Alle Nutzer sehen + editieren dieselbe Liste — keine User-Verwaltung, kein Auth, einfaches Familien-Setup.
- **Benannte gespeicherte Listen** in neuer Tabelle `einkaufsliste_gespeichert` (UNIQUE name): Aktuelle Auswahl unter einem Namen (max. 80 Zeichen) sichern, später wieder laden, oder löschen. Upsert-Verhalten beim Speichern (gleicher Name überschreibt).
- Neue API-Endpunkte: `cart.php` (GET/PUT), `saved_lists.php` (GET-Liste / GET ?name=X / POST / DELETE ?name=X)
- `cart`-Objekt in `app.js` neu gebaut: optimistic local-state + debounced PUT (300ms) zum Server, plus `cart.replaceAll(items)` (für „Liste laden") und `cart.refresh()` (Server frisch holen). Beim Render der Einkaufslisten-View wird automatisch refreshed.
- One-time-localStorage-Migration: alte Carts unter Key `rezepte.einkaufsliste.v1` werden beim ersten Start auf den Server gepusht (falls Server leer) und dann aus localStorage gelöscht.
- **Race-Condition**: Last-Write-Wins, bewusst keine Locks/ETags. Für den Use-Case akzeptabel.
- UI: Einkaufslisten-View hat oben eine `<details>`-Sektion „Gespeicherte Listen" (Tabelle Name/Anzahl/Datum + Laden/Löschen pro Zeile). Bei der Cart-Tabelle: „Speichern als"-Input mit Confirm beim Überschreiben.

### 2026-05-06 — Einkaufsliste: Aggregation über Rezept-Gruppen hinweg

- **Bug-Fix**: Die Zutaten-Aggregation in `einkaufsliste.php` hatte vorher die Rezept-interne `group` (z.B. "Teig", "Hauptzutaten") als Teil des Aggregations-Keys. Folge: gleiche Zutat (z.B. Ei) aus zwei Rezepten mit unterschiedlicher Gruppen-Zuordnung wurde nicht zusammengefasst — die Einkaufsliste zeigte sie zweimal.
- Neuer Aggregations-Key: nur `name + unit` (case-insensitiv). `group` wird ignoriert. Die Rezept-Gruppe ist eine Kochstruktur ("für den Teig", "für die Soße") und für den Einkauf unbrauchbar.
- Output ist jetzt eine flache, alphabetisch sortierte Liste. Antwort-Format kompatibel: `{ "liste": [{ "group": "", "items": [...] }] }` — Frontend rendert bei leerer Gruppe ohne Header.

### 2026-05-06 — Upload-View: Template-Download + KI-Prompt

- Upload-Seite hat jetzt einen Hinweis mit Download-Link auf `recipe_template.json` (base-relativ + `download`-Attribut → direkter File-Download statt Browser-Anzeige). Senkt die Einstiegshürde für neue Nutzer, die ohne Vorlage nicht wissen, welche Felder erlaubt sind.
- Zusätzlich Beispiel-KI-Prompt zur Rezept-Extraktion aus Webseiten in einer `prompt-box` mit Copy-to-Clipboard-Button. Workflow: Template + Webseiten-URL bei einer KI hochladen, Prompt einfügen → JSON kommt im erwarteten Format zurück.

### 2026-05-06 — Stolperstein: `attempt to write a readonly database`

- Sektion 10 (Stolpersteine) und README "Common pitfalls" um die alternative SQLite-Fehlermeldung erweitert
- Diese Variante kommt typischerweise **nachdem** die DB schon existiert, wenn Apache (`www-data`) keine Schreibrechte aufs `data/`-Verzeichnis hat: SQLite kann die Journal-Datei nicht anlegen
- Häufig nach Deploy via SCP/Git als persönlicher User — Verzeichnis-Owner bleibt der Deploy-User, Apache kommt nicht zum Schreiben

### 2026-05-06 — README.md (Installations-Anleitung, EN)

- Neue **`README.md`** auf Englisch für Operators/Deployer (Requirements, Step-by-step Install, Common Pitfalls, Update/Uninstall, Verlinkung auf DEVELOPER.md für tiefergehende Doku)
- Stolperstein „PHP-Version-Mismatch zwischen CLI und Web-SAPI" prominent dokumentiert (Hauptursache des „could not find driver"-Fehlers in der Praxis: `php-sqlite3` für eine andere Version installiert als die, die Apache lädt)
- README explizit als Living Document — bei Setup-/Dependency-Änderungen mitzupflegen, analog DEVELOPER.md bei Code-Änderungen

### 2026-05-05 — Mount-Point-Unabhängigkeit (Subdirectory-Deployment)

- App funktioniert jetzt unverändert in jedem Unterverzeichnis (`/`, `/rezepte/`, `/apps/foo/`, …)
- `index.html` → **`index.php`**: setzt `<base href="…">` dynamisch aus `dirname($_SERVER['SCRIPT_NAME'])`
- Neue **`assets/config.js`** exportiert `APP_BASE`, abgeleitet aus `import.meta.url` (single source of truth, robust auch ohne `<base>`-Tag)
- `assets/api.js`: `BASE = APP_BASE + 'api'` statt hartkodiertem `/api`
- `assets/app.js`: `getRoutePath()` strippt `APP_BASE` von `location.pathname` vor dem Routen-Match; `navigate(routePath)` prependet base. Click-Handler nutzt `link.pathname` (vom Browser gegen `<base>` aufgelöst).
- Alle Views: `href="/foo"` → `href="foo"` (base-relativ)
- `.htaccess`: `RewriteRule ^api/ - [L]` (relatives Pattern, ohne führenden Slash) statt `RewriteCond %{REQUEST_URI} ^/api/`. Wird per-directory gegen die Position der .htaccess gematcht — funktioniert in jedem Mount.
- PHP-Backend bleibt mount-agnostisch: `__DIR__`-basierte Pfade, Regex `#/api/rezepte(?:\.php)?/(\d+)$#` matcht beide Varianten
- **Verifiziert**: parallele Deployments unter `/` und `/test_subdir/` mit gleicher Codebase, eigene DB pro Mount, alle Endpunkte (GET-Liste/Detail, POST-Upload mit dry-run, PUT, DELETE, Einkaufsliste) sowie SPA-Routes (`/`, `/upload`, `/rezept/{id}`, `/rezept/{id}/bearbeiten`, `/einkaufsliste`, `/einkaufsliste/rezepte`) jeweils funktional

### 2026-05-05 — Einkaufsliste: „Komplette Rezepte" inline statt Navigation

- Aus dem `<a href="/einkaufsliste/rezepte">`-Link wurde ein `<button id="show-rezepte">`, der die Rezepte **inline** im `#ergebnis`-Bereich anzeigt — konsistent mit den anderen drei Buttons (Zutaten/Gewürze/Equipment). Vorher war es ein Link auf eine separate Seite, was die UX inkonsistent machte und sich „nicht implementiert" anfühlte.
- Helper aus `views/rezepte_print.js` exportiert (`renderRezeptHtml`, `recipesToText`, `loadCartRecipes`, `downloadRecipesAsText`) und sowohl von der Einkaufsliste als auch der Standalone-Print-Route genutzt — Single Source of Truth fürs Recipe-Rendering.
- Cart-Tabelle und Toolbar sind jetzt mit `.no-print` markiert, damit beim Drucken aus der Inline-Ansicht nur die Rezepte erscheinen.
- Standalone-Route `/einkaufsliste/rezepte` bleibt erhalten (für Bookmarks / Direkt-URLs), wird aber nicht mehr verlinkt.

### 2026-05-05 — Einkaufsliste: Gewürze, Küchenausstattung, Rezept-Export

- Einkaufsliste hat jetzt vier Output-Modi: Zutaten, Gewürze, Küchenausstattung, komplette Rezepte
- **Gewürze**: client-seitige Union aller `spices` aus den Cart-Rezepten, case-insensitive dedupliziert, alphabetisch (de-Locale)
- **Küchenausstattung**: client-seitige Union aller `kitchen_equipment`, Maximum-Quantity pro `name` (kein Aufsummieren — Geräte sind wiederverwendbar)
- Alle drei Aggregations-Modi haben Copy-to-Clipboard und `.txt`-Download
- Neue Route `/einkaufsliste/rezepte` mit `renderRezeptePrint()`: druckfreundliche Vollansicht aller Cart-Rezepte. `window.print()` für PDF-Speicherung über den Browser-Druckdialog, separater `.txt`-Export.
- Print-CSS (`@media print`): blendet Navigation/Footer/Buttons (`.no-print`) aus, Seitenumbrüche zwischen Rezepten
- `Promise.all(getRezept)` für paralleles Vollladen; Cache für die Volldaten zwischen den Aggregations-Buttons (invalidiert bei Personenzahl-Änderung oder Cart-Modifikation)

### 2026-05-05 — `Stk` als Einheit + echte Case-Insensitivität

- `Stk` (in beliebiger Schreibweise — `Stk`, `stk`, `STK`) wird jetzt zu `Pcs` normalisiert
- `translation_map.json` `units_de_to_en` um `Stk → Pcs` erweitert
- `unit_normalization_map()` um `Stk` ergänzt
- **Bug-Fix**: das vorher behauptete „case-tolerant" hat nur teilweise funktioniert (`strtolower(input)` wurde gegen die case-mixed Map gematcht — `stk` schlug fehl). Lookup geht jetzt korrekt: erst exakter Match, dann fallback mit `strtolower`-Vergleich gegen alle Map-Keys

### 2026-05-05 — Upload-Verfeinerung: Einheiten + Kategorie-Warnung

- `translation_map.json` um `units_de_to_en` / `units_en_to_de` erweitert (`Stück↔Pcs`, `Packung↔Pck`)
- `api/translation.php`: neue Funktionen `unit_normalization_map()`, `normalize_single_unit()`, `normalize_units_in_recipe()`. Wird automatisch in `normalize_recipe()` aufgerufen → Upload UND PUT normalisieren Einheiten konsistent.
- Konvertierungen: `kg→g×1000`, `L/l→ml×1000`, `EL→g×15`, `TL→g×5`, `Stück/Stueck→Pcs`, `Packung→Pck`. Unbekannte Einheit ⇒ HTTP 400 mit Abbruch.
- `api/upload.php`: neuer `dry_run`-Modus (POST- oder GET-Param). Liefert `{ok, warnings, preview}` ohne zu schreiben. Kategorie-Existenzcheck: wenn neu, kommt eine `new_category`-Warnung — wird beim echten Save als Soft-Warning mit zurückgegeben, blockiert aber nicht.
- `assets/units.js` neu: `displayUnit()` für die Anzeige (`Pcs`→„Stück", `Pck`→„Packung").
- `views/upload.js` umgebaut: bei Datei-Auswahl wird automatisch dry-run gemacht; normalisierte Vorschau mit deutschen Einheiten + Warnungs-Box; Speichern/Abbrechen-Buttons.
- `views/rezepte.js` und `views/einkaufsliste.js`: `displayUnit()` bei der Anzeige + im Text-Export.

### 2026-05-05 — Bearbeiten & Löschen

- `api/translation.php` extrahiert (`load_translation_map`, `translate_keys`,
  `normalize_recipe`) — Single Source of Truth für Validierung/Normalisierung
- `rezepte.php` umstrukturiert: zentrales Routing per HTTP-Method,
  neue Handler `handlePut()` und `handleDelete()`
- `X-HTTP-Method-Override` als Fallback für PUT/DELETE
- Frontend: Detail-View bekommt Buttons "Bearbeiten" und "Löschen";
  neue Route `/rezept/{id}/bearbeiten` mit JSON-Editor; Cart wird beim
  Löschen mit aufgeräumt
- `api.js`: `updateRezept`, `deleteRezept`
- CORS `Access-Control-Allow-Methods` um PUT/DELETE erweitert

---

## 13. Pflege dieses Dokuments

Bei jeder größeren Änderung:

1. **Section 6 (API-Endpunkte)** anpassen, wenn sich Endpunkte ändern
2. **Section 8 (Frontend)** anpassen, wenn Routes/Views/State sich ändern
3. **Section 10 (Stolpersteine)** ergänzen, wenn ein neues
   Setup-/Runtime-Problem aufschlägt — Fixes lieber dokumentieren als
   Nachfolger:innen erneut debuggen lassen
4. **Section 12 (Changelog)** mit neuem Datum + Bullet-List ergänzen
5. Bei Schema-Änderungen: `bootstrap.php` mit `ALTER TABLE` oder
   Migrations-Logik erweitern und in Section 3 dokumentieren
