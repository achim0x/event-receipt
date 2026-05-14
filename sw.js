// Service Worker für die Rezepte-PWA.
//
// Liegt im App-Root damit der Scope auf den gesamten Mount-Point passt
// (sw.js neben index.php → scope kann '/' oder '/rezepte/' sein, je nach
// Position der App). Wird aus app.js mit explizitem scope registriert.
//
// Strategien:
//   - Navigation (HTML)     → Network-first mit App-Shell-Fallback
//   - Statische Assets      → Cache-first (mit Hintergrund-Update)
//   - GET /api/*            → Stale-While-Revalidate
//   - POST/PUT/DELETE       → kein Caching, durchreichen
//
// Beim Deploy: CACHE_VERSION hochziehen → alle alten Caches werden
// beim activate-Event aufgeräumt.

const CACHE_VERSION = 'v24';
const PRECACHE = `precache-${CACHE_VERSION}`;
const RUNTIME = `runtime-${CACHE_VERSION}`;

// Der Scope, in dem dieser SW operiert (= Mount-Point der App).
// Beispiel: '/' im Root-Deploy, '/rezepte/' im Subdir-Deploy.
const SCOPE = new URL('./', self.location.href).pathname;

// App-Shell + Core-Module, die beim install eingecacht werden.
// Pfade relativ zum SCOPE; werden über new URL() resolved.
const PRECACHE_PATHS = [
    './',  // App-Shell-Einstiegspunkt (= SCOPE). Wichtig: NICHT '' setzen —
           // new URL('', sw.js-URL) würde auf die SW-Datei selbst resolven
           // und dann läge der SW-Quelltext als „App-Shell" im Cache.
    'manifest.webmanifest',
    'assets/style.css',
    'assets/config.js',
    'assets/app.js',
    'assets/api.js',
    'assets/units.js',
    'assets/tags.js',
    'assets/aggregate.js',
    'assets/checks_queue.js',
    'assets/views/rezepte.js',
    'assets/views/rezept_form.js',
    'assets/views/upload.js',
    'assets/views/einkaufsliste.js',
    'assets/views/rezepte_print.js',
    'assets/views/setup.js',
    'assets/views/geraete.js',
    'assets/views/pair.js',
    'assets/icons/icon.svg',
    'assets/icons/icon-192.png',
    'assets/icons/icon-512.png',
    'assets/icons/apple-touch-icon-180.png',
];

const PRECACHE_URLS = PRECACHE_PATHS.map(p => new URL(p, self.location.href).toString());
const APP_SHELL_URL = PRECACHE_URLS[0];  // SCOPE — Index/App-Shell

// Beim install: App-Shell und Core-Assets vorab cachen
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(PRECACHE);
        // Einzeln cachen damit ein fehlschlagender Eintrag die ganze Install
        // nicht zerschießt — wichtiger als atomicity ist Robustheit gegen
        // umbenannte/entfernte Files.
        await Promise.allSettled(PRECACHE_URLS.map(async (url) => {
            try {
                const res = await fetch(url, { cache: 'no-cache' });
                if (res.ok) await cache.put(url, res);
            } catch (err) {
                console.warn('[SW] precache miss', url, err);
            }
        }));
        // Sofort aktiv werden statt auf nächsten reload zu warten
        await self.skipWaiting();
    })());
});

// Beim activate: alte Caches aufräumen
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter(k => k !== PRECACHE && k !== RUNTIME).map(k => caches.delete(k))
        );
        // Sofort Kontrolle über offene Tabs übernehmen
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);

    // Nur same-origin und GET behandeln — alles andere passthrough
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;
    // Pfade außerhalb des Scopes ignorieren
    if (!url.pathname.startsWith(SCOPE)) return;

    // SPA-Navigation: Network-first, Cache-Fallback auf App-Shell
    if (req.mode === 'navigate') {
        event.respondWith(networkFirstWithShell(req));
        return;
    }

    // API-GETs: Stale-While-Revalidate. Ausnahmen mit Network-Passthrough:
    //  - setup.php / auth.php — Auth-Status muss live aktuell sein, sonst
    //    sieht der User stale Setup-Schritte.
    //  - export.php — Backup-/Migrations-Download muss garantiert die
    //    aktuellsten Rezepte enthalten. Stale-While-Revalidate würde beim
    //    Klick einen veralteten Stand liefern und erst danach im Hintergrund
    //    refreshen.
    if (url.pathname.startsWith(SCOPE + 'api/')) {
        if (url.pathname.endsWith('/setup.php')
            || url.pathname.endsWith('/auth.php')
            || url.pathname.endsWith('/export.php')) {
            return;  // Browser-default = network passthrough
        }
        event.respondWith(staleWhileRevalidate(req));
        return;
    }

    // Statische Assets: Cache-First
    event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') {
            const cache = await caches.open(RUNTIME);
            cache.put(req, res.clone()).catch(() => {});
        }
        return res;
    } catch (err) {
        // Offline und nichts im Cache → Browser-Fehler bubbelt durch
        throw err;
    }
}

async function staleWhileRevalidate(req) {
    const cache = await caches.open(RUNTIME);
    const cached = await cache.match(req);
    const networkPromise = fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
            cache.put(req, res.clone()).catch(() => {});
        }
        return res;
    }).catch(() => null);

    // Wenn Cache da: sofort liefern, Netzwerk läuft im Hintergrund weiter
    // Sonst: auf Netzwerk warten (oder Fehler weiterreichen)
    if (cached) {
        networkPromise.catch(() => {});  // fire-and-forget, kein unhandled rejection
        return cached;
    }
    const fresh = await networkPromise;
    if (fresh) return fresh;
    // Beides nicht da → kein Cache, kein Netz: Browser-Default-Error
    return new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
    });
}

async function networkFirstWithShell(req) {
    try {
        const res = await fetch(req);
        return res;
    } catch (err) {
        // Offline: App-Shell aus dem Cache liefern. SPA-Router rendert
        // dann die View basierend auf location.pathname.
        const shell = await caches.match(APP_SHELL_URL);
        if (shell) return shell;
        throw err;
    }
}

// Erlaubt der App via postMessage, den waiting-SW sofort zu aktivieren
// (z.B. nach „Update verfügbar — Neu laden"-Banner-Klick)
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
