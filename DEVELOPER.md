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
/var/www/html/
├── index.html                  # SPA-Shell (lädt /assets/app.js)
├── .htaccess                   # Rewrite: /api/* → PHP, alles andere → index.html
├── REZEPT_APP_SPEC.md          # Original-Spec (historisch)
├── DEVELOPER.md                # dieses Dokument
├── recipe_template.json        # leere Vorlage (EN-Keys)
├── translation_map.json        # DE↔EN Key-Mapping
├── api/
│   ├── bootstrap.php           # PDO + Schema + CORS + Error-Handler
│   ├── translation.php         # DE→EN Normalisierung + Validierung (shared)
│   ├── rezepte.php             # GET-Liste, GET-Einzeln, PUT, DELETE
│   ├── upload.php              # POST (multipart oder raw JSON) → INSERT
│   └── einkaufsliste.php       # POST → aggregierte Einkaufsliste
├── assets/
│   ├── app.js                  # Router + Cart-State (localStorage)
│   ├── api.js                  # Fetch-Wrapper
│   ├── style.css
│   └── views/
│       ├── rezepte.js          # List, Detail, Edit (renderRezept{Liste,Detail,Edit})
│       ├── upload.js           # Drag&Drop + JSON-Vorschau
│       └── einkaufsliste.js    # Cart-Verwaltung + Generator + Export
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
        { "quantity": 100, "unit": "g", "name": "Spaghetti" }
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

## 5. DE↔EN Key-Übersetzung

`translation_map.json` enthält:

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

Max. 1 MB. Validierung wie PUT. Antwort `201 Created`:

```json
{ "success": true, "id": 42 }
```

### `POST /api/einkaufsliste.php`

Body:

```json
{ "rezepte": [ { "id": 1, "personen": 4 }, { "id": 2, "personen": 2 } ] }
```

Logik:
1. Rezepte zu den IDs aus DB laden
2. Pro Rezept Mengen mit `personen / 1` multiplizieren (Basis = 1 Person)
3. Gleiche Items (Match auf `name` + `unit`, case-insensitive) summieren —
   gruppiert pro `group`-Feld, **innerhalb der jeweiligen Gruppe** zusammengefasst
4. Pro Gruppe alphabetisch nach `name` sortieren, Gruppen alphabetisch

```json
{ "liste": [
  { "group": "Hauptzutaten",
    "items": [ { "quantity": 400, "unit": "g", "name": "Spaghetti" } ] }
] }
```

### Method-Override

Falls Apache PUT/DELETE blockiert (z. B. restriktive Konfigs), akzeptiert
`rezepte.php` auch `POST` mit `X-HTTP-Method-Override: PUT|DELETE` oder
`?_method=PUT|DELETE`. Aktuell wird das vom Frontend nicht genutzt, ist
aber als Fallback vorhanden.

---

## 7. Apache-Routing (`.htaccess`)

```apache
RewriteEngine On

# /api/* direkt durch PHP
RewriteCond %{REQUEST_URI} ^/api/
RewriteRule ^ - [L]

# Statische Dateien direkt liefern
RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]

# Alles andere → SPA
RewriteRule ^ index.html [L]

php_value upload_max_filesize 2M
php_value post_max_size 2M
```

**Wichtig**: das `php_value` funktioniert nur mit `mod_php` (nicht
PHP-FPM). Wenn der Server auf FPM umgestellt wird, muss das in `php.ini`
oder per `SetEnv` umkonfiguriert werden.

---

## 8. Frontend

### Router & State (`assets/app.js`)

Globaler State minimal — nur die Einkaufsliste:

```js
const state = { einkaufsliste: [] };  // [{ id, titel, personen }]
```

Persistenz via `localStorage` unter Key `rezepte.einkaufsliste.v1`. Der
Cart wird über das exportierte `cart`-Objekt manipuliert (`add`,
`remove`, `setPersonen`, `clear`, `has`, `all`).

**Routes** (`pushState`-basiert, Patterns matchen in Reihenfolge —
spezifischere zuerst):

| Pattern                          | View                    |
|---------------------------------|-------------------------|
| `/`                              | Rezeptliste             |
| `/rezept/{id}`                   | Detail                  |
| `/rezept/{id}/bearbeiten`        | JSON-Editor             |
| `/upload`                        | Upload-View             |
| `/einkaufsliste`                 | Einkaufslisten-Ansicht  |

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
- "🗑 Löschen" → Confirm + `DELETE` + Cart-Cleanup + Navigation auf `/`

**`renderRezeptEdit`** — Textarea mit aktuellem JSON, Speichern/Reset/
Abbrechen. Beim Speichern wird `cart`-Eintrag mit aktualisiertem Titel
neu eingetragen, falls das Rezept dort liegt.

**`renderUpload`** — Drag&Drop oder File-Picker, JSON parsen und
Vorschau (Titel, Kategorie, Zutaten-Anzahl, Roh-JSON in `<details>`).

**`renderEinkaufsliste`** — Cart-Tabelle mit Personenzahl-Inputs, Liste
generieren, Ergebnis als Checkliste, Copy-to-Clipboard und
`.txt`-Download.

### Fetch-Wrapper (`assets/api.js`)

Methoden:
- `listRezepte({ suche, kategorie })`
- `getRezept(id)`
- `uploadRezept(file)` / `uploadRezeptJson(obj)`
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
| `unable to open database file` | `data/` nicht beschreibbar für Apache | `chmod 777 data/` (oder `chown www-data data/`) |
| Detail-Endpunkt liefert Liste statt Einzel-Rezept | Pfad-Regex matcht nicht | aktueller Regex matcht `/api/rezepte/{id}` UND `/api/rezepte.php/{id}` |
| Cart enthält gelöschtes Rezept | Cart wird auf Server-Seite nicht synchronisiert | Frontend ruft `cart.remove()` nach `DELETE` auf — bei direkten DB-Eingriffen muss man im Browser localStorage manuell leeren |

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
