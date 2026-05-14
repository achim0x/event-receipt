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
- **Shared shopping list**: cart is server-backed and shared across all users (no auth — single household / small group use case)
- **Named saved lists**: save the current cart under a name, load it back later, manage multiple saved lists
- **Frozen snapshots**: saved lists capture a frozen copy of the referenced recipes — editing a recipe later does not retroactively change a previously saved shopping list
- **Store-section grouping**: ingredients can carry an optional `department` (Obst/Gemüse, Frische Theke, Non-Food, Getränke, Backen, Grundnahrungsmittel); the generated shopping list groups items accordingly with anything unlabelled under "Sonstiges"
- **Backup & migration**: download a single recipe as JSON from its detail view, or export/import the entire collection as one JSON file (suitable for backup or moving to another instance). Batch import validates each recipe individually and reports per-record failures while still importing the rest.
- **Persistent check-off state**: ticked items on the shopping list stay ticked across reloads and are shared across devices (great for "I already got the flour" coordination); survives serving-size changes

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
sudo apt install php-sqlite3                # critical — see "Common pitfalls"
sudo a2enmod rewrite headers                # rewrite: SPA routing; headers: CSP & security headers
sudo systemctl reload apache2
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

### 3b. Verify `mod_headers` is enabled (already done in step 1)

The bundled `.htaccess` sets a strict Content-Security-Policy plus
`X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy` on
**static** files — these need Apache's `mod_headers` (was enabled in
step 1 via `a2enmod rewrite headers`). To double-check:

```bash
apachectl -M 2>&1 | grep headers
# expected output: headers_module (shared)
```

If missing:

```bash
sudo a2enmod headers
sudo systemctl reload apache2
```

The PHP backend sets the same headers itself for API responses, so
the app is already hardened even without `mod_headers` — but static
assets benefit too once the module is enabled.

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

### `unable to open database file` or `attempt to write a readonly database`

Both messages mean the same thing in practice: the `data/` directory
or the SQLite file isn't writable by Apache's user (`www-data` on
Debian/Ubuntu).

The misleading "readonly database" wording is SQLite's way of saying
it can't create its journal file (`rezepte.db-journal` / `-wal` /
`-shm`) next to the DB — which requires **directory** write access,
not just file access. Re-running step 3 fixes both:

```bash
sudo chown -R www-data:www-data <install-dir>/data
sudo chmod 775 <install-dir>/data
sudo chmod 664 <install-dir>/data/rezepte.db   # if it already exists
```

A common trigger is uploading the app as a non-Apache user — Apache
creates the DB file successfully (because it can write into a
temporarily-loose directory), but later writes fail because the
directory ownership stays with the deploy user.

### Upload fails with `500 — could not read translation_map.json`

`translation_map.json` is not readable by Apache. Re-run the `chmod
644` command from step 3.

### `Unbekannte Einheit "X" bei Zutat ...`

Your JSON uses an ingredient unit that's not in the normalization
map (allowed: `g`, `ml`, `Pck`, `Pcs`, plus auto-converted `kg`, `L`,
`EL`, `TL`, `Stück`, `Stueck`, `Stk`, `Packung`). Either fix the JSON
or extend the map — see [DEVELOPER.md §5.2](DEVELOPER.md#52-einheiten).

---

## Mobile / PWA

The app is a Progressive Web App — it can be installed on the home
screen of any modern mobile browser and works offline once the assets
are cached.

### Install on iOS

1. Open the app URL in **Safari** (Chrome on iOS does not support
   add-to-home-screen for third-party PWAs).
2. Tap the share button (square with up-arrow).
3. Tap **„Zum Home-Bildschirm"**.
4. Confirm with **Hinzufügen**.

The app appears as its own icon, opens in standalone mode (no Safari
chrome), and remembers its state across launches.

### Install on Android

1. Open the app URL in **Chrome** (or any Chromium-based browser).
2. Open the browser menu → **App installieren** (or „Zum
   Startbildschirm hinzufügen").
3. Confirm.

### Offline behaviour

Once installed and opened once with a working connection:
- App shell (HTML/CSS/JS, icons) is served from the local cache and
  works in airplane mode.
- Recipes, the current cart and saved lists are cached from their
  most recent online request (stale-while-revalidate). Reading
  recipes offline works; you see the last synced state.
- Generating the shopping list works offline as long as the recipes
  are in the snapshot or in the cache.
- Writing (uploading recipes, modifying the cart, saving lists)
  requires a connection — the UI shows the offline state.
- Phase 2 of the PWA work introduces persisted checkbox state with
  background-sync (planned).

### Enable device-pairing (optional, opt-in)

By default the app is open — anyone reaching the URL has full access.
That's fine for a LAN/single-household setup. For Internet-facing
deployments you can switch on token-based device pairing:

1. In `api/bootstrap.php`, set `const REQUIRE_AUTH_TOKEN = true;`
2. Reload the app — the browser lands on `/setup`
3. Click „Setup-Token erzeugen"
4. SSH to the server and read the one-shot token:
   `cat <install-dir>/data/admin_setup_token.txt`
5. Paste it on `/setup` → you're logged in as Web Admin (cookie set)
6. Go to „Geräte" in the top nav → „Pairing-Code erzeugen"
7. On the phone: open the PWA URL → automatic redirect to `/pair` →
   enter the 8-character code (XXXX-XXXX) within 5 minutes
8. The phone stores a bearer token in localStorage; from now on every
   request is signed

Revoke compromised devices from the same „Geräte" screen. Logout
clears the web cookie only — bearer tokens stay valid until revoked.

### Replace placeholder icons

The bundled icons in `assets/icons/` are minimal placeholders (single-
colour upscaled blocks for the PNGs; a simple vector pot for the SVG).
For production polish, replace them with proper designs — keep the
same filenames so the manifest needs no edits.

## Security model

This app is designed for a **trusted LAN / single-household** setup
with no user accounts — anyone who can reach the URL has full read and
write access. The threat model and the hardening it ships with is
covered in `DEVELOPER.md` section 10.X.

**If you intend to expose the app on the public Internet**, you MUST
add the following layers — the app alone is not enough:

1. **HTTPS** via a reverse proxy (Caddy, nginx, Apache vhost) with
   Let's Encrypt. Then uncomment the HSTS line in `.htaccess`.
2. **Authentication** — the app has none. Front it with nginx
   `auth_basic`, `oauth2-proxy`, Authelia, etc.
3. `ServerTokens Prod` and `ServerSignature Off` in your Apache config
   to hide the Apache version banner.
4. Enable `mod_headers` (see step 3b above) so the CSP/security headers
   are applied to static assets too, not just PHP responses.
5. Periodic backups of `data/rezepte.db` (or via the export API).
6. **No `phpinfo.php`** anywhere in the web root.

What's already covered out of the box:
- CSRF protection (Origin/Referer check on state-changing requests)
- XSS hardening (output encoding + CSP)
- Clickjacking protection (X-Frame-Options + frame-ancestors)
- SQL injection (prepared statements throughout)
- Direct file access to the SQLite DB and dotfiles is blocked by `.htaccess`
- Input sanitisation with length limits and NULL-byte stripping
- Generic 500 error responses (no internal path/class leakage)

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

This project is licensed under the **GNU General Public License v3.0**
(GPL-3.0). See the [LICENSE](LICENSE) file for the full text.

In short: you are free to use, study, modify, and redistribute this
software, but any derivative work you distribute must also be released
under the GPL-3.0 and must include the source. There is no warranty.

Source repository: <https://github.com/achim0x/event-receipt>
