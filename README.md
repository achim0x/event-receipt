# Rezepte — Recipe Database Web App

A self-hosted recipe database with shopping list aggregation. Vanilla JS
single-page app in front, PHP + SQLite in back. No build step, no
JavaScript framework, no Composer.

**Features**
- Recipes stored as JSON, with German or English keys (auto-translated)
- Live ingredient scaling by serving size
- Multi-recipe shopping list with unit normalization and aggregation
- Aggregated spice and kitchen-equipment lists across selected recipes
- Print/PDF export of full recipe collections
- JSON upload with validation, dry-run preview, and unit auto-conversion
- Edit recipes directly via JSON editor

**Tech Stack**
- PHP 8.x (PDO/SQLite, JSON)
- Apache 2.4 with `mod_rewrite`
- SQLite 3 (no separate database server)
- Vanilla ES modules (no bundler, no npm)

---

## Requirements

| Component | Version | Notes |
|---|---|---|
| PHP | 8.0 or newer | Web SAPI, **not** just CLI — see "Common pitfalls" |
| `pdo_sqlite` extension | matching the web PHP version | Most common deploy issue |
| Apache | 2.4 | with `mod_rewrite` enabled and `AllowOverride All` for the install dir |
| Disk | < 5 MB for the app | Plus whatever the recipe DB grows to |
| Browser | any with ES module support (2018+) | No transpilation |

The `mbstring` extension is **optional** — the code falls back to `strtolower()` when not present.

---

## Installation

### 1. Install Apache, PHP and the SQLite driver

#### Debian / Ubuntu

```bash
sudo apt install apache2 php libapache2-mod-php
sudo apt install php-sqlite3        # critical — see "Common pitfalls"
sudo a2enmod rewrite
```

> **Important**: on systems with multiple PHP versions installed in
> parallel (e.g. via Ondřej Surý's PPA), the package name must match
> the PHP version Apache is actually using. For example
> `php8.3-sqlite3` if Apache is bound to PHP 8.3. To verify which
> version Apache uses:
>
> ```bash
> ls /etc/apache2/mods-enabled/php*.load
> ```
> or place a temporary `phpinfo.php` in your web root and look at
> the version banner. **Delete it after diagnosing** — `phpinfo()`
> exposes server internals.

#### Other distributions
Install Apache, PHP, and the corresponding `pdo_sqlite` package
(`php-pdo_sqlite`, `php-sqlite`, etc.). Enable `mod_rewrite`.

### 2. Deploy the files

Copy the contents of this directory to your web root or any
subdirectory:

```bash
# Deploy at the document root
sudo cp -r ./ /var/www/html/

# OR deploy in a subdirectory — works without any reconfiguration
sudo cp -r ./ /var/www/html/rezepte/
```

The app **auto-detects its mount point** — no edits needed regardless
of where you put it. See [DEVELOPER.md §7.1](DEVELOPER.md#71-mount-point-unabhängigkeit-subdirectory-deployment)
for how this works.

### 3. Set file permissions

```bash
# Apache (running as www-data) needs to read these files
sudo chmod 644 <install-dir>/translation_map.json
sudo chmod 644 <install-dir>/recipe_template.json

# Apache needs to create and write the SQLite DB here
sudo chmod 775 <install-dir>/data
sudo chown www-data:www-data <install-dir>/data
```

### 4. Allow `.htaccess` overrides

Apache must honour the bundled `.htaccess` for SPA routing to work.
Edit `/etc/apache2/apache2.conf` (or your vhost config) and ensure the
block covering your install directory has:

```apache
<Directory /var/www/html/>
    Options FollowSymLinks
    AllowOverride All
    Require all granted
</Directory>
```

Reload Apache:

```bash
sudo systemctl reload apache2
```

### 5. Verify

Open the install URL in a browser:
- root deploy: `http://your-host/`
- subdirectory: `http://your-host/rezepte/`

You should see the empty recipe list with a hint to upload your first
recipe. The SQLite database `data/rezepte.db` is created automatically
on the first request.

Use `recipe_template.json` (in the install dir) as a starting point
for your first upload.

---

## Common pitfalls

These are the issues that come up most often during deployment. The
[DEVELOPER.md "Stolpersteine" table](DEVELOPER.md#10-bekannte-stolpersteine)
has the complete list.

### `Error: Server error: could not find driver`

The `pdo_sqlite` extension is missing **for the PHP version Apache
uses**. The CLI may have it (`php -m | grep sqlite` shows it) while
the web SAPI does not — always verify against `phpinfo()` from a
browser, not the CLI.

```bash
# Apache uses this version:
ls /etc/apache2/mods-enabled/php*.load
# e.g. php8.3.load → install php8.3-sqlite3
sudo apt install php8.3-sqlite3
sudo systemctl reload apache2
```

### `404` on every URL except `/`

`AllowOverride None` is set somewhere — `.htaccess` is being ignored.
Set `AllowOverride All` for the install directory (step 4 above) and
reload Apache.

### `unable to open database file`

The `data/` directory is not writable by Apache's user (`www-data` on
Debian/Ubuntu). Re-run the `chmod`/`chown` commands from step 3.

### Upload fails with `500 — could not read translation_map.json`

`translation_map.json` is not readable by Apache. Re-run the `chmod
644` command from step 3.

### `Unbekannte Einheit "X" bei Zutat ...`

Your JSON uses an ingredient unit that's not in the normalization
map (allowed: `g`, `ml`, `Pck`, `Pcs`, plus auto-converted `kg`, `L`,
`EL`, `TL`, `Stück`, `Stueck`, `Stk`, `Packung`). Either fix the JSON
or extend the map — see [DEVELOPER.md §5.2](DEVELOPER.md#52-einheiten).

---

## Updating

Pull the new files and overwrite. The database schema is auto-managed
(`CREATE TABLE IF NOT EXISTS` in `api/bootstrap.php`) — no manual
migration.

```bash
# Backup your DB before any update
cp <install-dir>/data/rezepte.db <install-dir>/data/rezepte.db.bak

# Then deploy the new files (preserve data/ and your translation_map.json
# if you've extended it)
rsync -av --exclude=data --exclude=translation_map.json \
    new-version/ <install-dir>/
```

---

## Uninstall

The app is fully self-contained:

```bash
sudo rm -rf <install-dir>
```

That removes everything including the SQLite database.

---

## Documentation

| Document | Audience |
|---|---|
| **README.md** (this file) | Operators / deployers |
| [DEVELOPER.md](DEVELOPER.md) | Developers extending or modifying the app — covers architecture, API endpoints, schema, conventions, troubleshooting, and a full changelog |
| [REZEPT_APP_SPEC.md](REZEPT_APP_SPEC.md) | Original specification (historical reference) |

---

## License

(Add your license here.)
