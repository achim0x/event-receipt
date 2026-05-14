import { APP_BASE } from './config.js';
import { api, onTokenInvalid, getToken } from './api.js';
import * as checksQueue from './checks_queue.js';
import { renderRezeptListe, renderRezeptDetail, renderRezeptEdit } from './views/rezepte.js';
import { renderUpload } from './views/upload.js';
import { renderEinkaufsliste } from './views/einkaufsliste.js';
import { renderRezeptePrint } from './views/rezepte_print.js';
import { renderSetup } from './views/setup.js';
import { renderGeraete } from './views/geraete.js';
import { renderPair } from './views/pair.js';

// Legacy localStorage-Key — wird einmalig beim ersten Start auf den Server
// migriert (falls Server-Cart noch leer und localStorage Items enthält) und
// danach gelöscht.
const LEGACY_STORAGE_KEY = 'rezepte.einkaufsliste.v1';

let cartState = { items: [], snapshot: {} };
let cartInitialized = false;
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 300;

function updateBadge() {
    const badge = document.getElementById('cart-badge');
    if (!badge) return;
    const count = cartState.items.length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
}

function isPlainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeSnapshot(s) {
    return isPlainObject(s) ? s : {};
}

function readLegacyCart() {
    try {
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : null;
        return Array.isArray(arr) ? arr : null;
    } catch {
        return null;
    }
}

function clearLegacyCart() {
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch {}
}

async function loadCartFromServer() {
    try {
        const data = await api.getCart();
        cartState.items = Array.isArray(data.items) ? data.items : [];
        cartState.snapshot = normalizeSnapshot(data.snapshot);
    } catch (err) {
        console.error('Cart laden fehlgeschlagen:', err);
        cartState = { items: [], snapshot: {} };
    }
    updateBadge();
}

async function initCart() {
    const legacy = readLegacyCart();

    try {
        const data = await api.getCart();
        const serverItems = Array.isArray(data.items) ? data.items : [];
        const serverSnapshot = normalizeSnapshot(data.snapshot);

        if (serverItems.length === 0 && legacy && legacy.length > 0) {
            // One-time-migration: legacy localStorage → Server (kein Snapshot)
            cartState.items = legacy;
            cartState.snapshot = {};
            try {
                await api.putCart(cartState.items, {});
            } catch (err) {
                console.error('Legacy-Cart-Migration zum Server fehlgeschlagen:', err);
            }
        } else {
            cartState.items = serverItems;
            cartState.snapshot = serverSnapshot;
        }
    } catch (err) {
        console.error('Cart-Init: Server-Fetch fehlgeschlagen, fallback auf legacy/leer:', err);
        cartState = { items: legacy || [], snapshot: {} };
    }

    clearLegacyCart();
    cartInitialized = true;
    updateBadge();
}

function scheduleCartSave() {
    if (!cartInitialized) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        try {
            await api.putCart(cartState.items, cartState.snapshot);
        } catch (err) {
            console.error('Cart-Sync zum Server fehlgeschlagen:', err);
        }
    }, SAVE_DEBOUNCE_MS);
}

export const cart = {
    all: () => cartState.items.slice(),
    /** Snapshot-Map {rezept_id: {titel, kategorie, quelle, zubereitungszeit, daten}}.
     *  Wenn nicht leer, ist die App im Snapshot-Modus für die enthaltenen IDs. */
    snapshot: () => cartState.snapshot,
    has: (id) => cartState.items.some(r => r.id === id),
    add(rezept, personen = 1) {
        if (cart.has(rezept.id)) return false;
        cartState.items.push({
            id: rezept.id,
            titel: rezept.titel,
            personen: Math.max(1, parseInt(personen, 10) || 1),
        });
        // Snapshot wird NICHT verändert — neu hinzugefügte Rezepte nutzen live data.
        updateBadge();
        scheduleCartSave();
        return true;
    },
    remove(id) {
        cartState.items = cartState.items.filter(r => r.id !== id);
        // Snapshot für entferntes Rezept droppen — bringt nichts mehr.
        if (cartState.snapshot && Object.prototype.hasOwnProperty.call(cartState.snapshot, id)) {
            delete cartState.snapshot[id];
        }
        updateBadge();
        scheduleCartSave();
    },
    setPersonen(id, personen) {
        const entry = cartState.items.find(r => r.id === id);
        if (!entry) return;
        entry.personen = Math.max(1, parseInt(personen, 10) || 1);
        scheduleCartSave();
    },
    clear() {
        cartState.items = [];
        cartState.snapshot = {};
        updateBadge();
        scheduleCartSave();
    },
    /** Komplette Liste durch geladene Items + optional Snapshot ersetzen — z.B. beim Laden einer gespeicherten Liste */
    replaceAll(items, snapshot = {}) {
        cartState.items = (Array.isArray(items) ? items : []).map(r => ({
            id: parseInt(r.id, 10),
            titel: String(r.titel || ''),
            personen: Math.max(1, parseInt(r.personen, 10) || 1),
        }));
        cartState.snapshot = normalizeSnapshot(snapshot);
        updateBadge();
        scheduleCartSave();
    },
    /** Aktuellen Stand vom Server neu laden (z.B. wenn ein anderer Tab/User editiert hat) */
    refresh: loadCartFromServer,
};

const routes = [
    { pattern: /^\/$/, handler: () => renderRezeptListe(app) },
    { pattern: /^\/rezept\/(\d+)\/bearbeiten$/, handler: (m) => renderRezeptEdit(app, parseInt(m[1], 10)) },
    { pattern: /^\/rezept\/(\d+)$/, handler: (m) => renderRezeptDetail(app, parseInt(m[1], 10)) },
    { pattern: /^\/upload$/, handler: () => renderUpload(app) },
    { pattern: /^\/einkaufsliste\/rezepte$/, handler: () => renderRezeptePrint(app) },
    { pattern: /^\/einkaufsliste$/, handler: () => renderEinkaufsliste(app) },
    { pattern: /^\/setup$/, handler: () => renderSetup(app) },
    { pattern: /^\/geraete$/, handler: () => renderGeraete(app) },
    { pattern: /^\/pair$/, handler: () => renderPair(app) },
];

const app = document.getElementById('app');

const BASE_NO_TRAIL = APP_BASE.replace(/\/$/, '');

function getRoutePath() {
    const p = location.pathname;
    if (p === BASE_NO_TRAIL || p === APP_BASE) return '/';
    if (p.startsWith(APP_BASE)) return '/' + p.slice(APP_BASE.length);
    return p;
}

function navigate(routePath, replace = false) {
    const dest = (!routePath || routePath === '/') ? APP_BASE : BASE_NO_TRAIL + routePath;
    if (replace) history.replaceState({}, '', dest);
    else history.pushState({}, '', dest);
    render();
}

function render() {
    const path = getRoutePath();
    for (const { pattern, handler } of routes) {
        const m = path.match(pattern);
        if (m) {
            handler(m);
            return;
        }
    }
    app.innerHTML = `<div class="empty"><h2>404 — Seite nicht gefunden</h2><p><a href="." data-link>Zurück zur Übersicht</a></p></div>`;
}

document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-link]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return;
    e.preventDefault();
    history.pushState({}, '', link.pathname);
    render();
});

window.addEventListener('popstate', render);

// --- Network-Status -------------------------------------------------------
// Setzt body.is-offline auf Basis von navigator.onLine und reagiert auf
// online/offline-Events. CSS in style.css blendet einen Banner ein und
// dämpft Elemente mit .needs-network-Klasse.
function updateOfflineClass() {
    document.body.classList.toggle('is-offline', !navigator.onLine);
}
updateOfflineClass();
window.addEventListener('online', updateOfflineClass);
window.addEventListener('offline', updateOfflineClass);

// --- Pending-Häkchen synchronisieren --------------------------------------
// Wenn das Gerät online wird oder der Tab wieder sichtbar wird, versuchen
// wir die in IndexedDB gequeueten Check-Mutations zum Server zu pushen.
// Last-Write-Wins per Schlüssel; permanente Fehler bleiben in der Queue
// und werden beim nächsten Anlauf wieder probiert.
function tryFlushChecks() {
    if (!navigator.onLine) return;
    checksQueue.flush(api).catch(err => console.warn('Pending-Sync fehlgeschlagen:', err));
}
window.addEventListener('online', tryFlushChecks);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tryFlushChecks();
});
// Beim App-Start einmal probieren (Initial-Sync falls noch was anhängt)
tryFlushChecks();

export { navigate };
export const network = {
    isOnline: () => navigator.onLine,
};

// Bei 401-Antwort eines API-Calls: Token war ungültig → falls wir nicht
// schon auf /pair sind, dort hin redirecten.
onTokenInvalid(() => {
    const p = getRoutePath();
    if (p !== '/pair' && p !== '/setup') {
        navigate('/pair', true);
    }
});

// Beim App-Start: Auth-Status checken. Wenn Auth aktiv ist und kein
// gültiger Token vorhanden ist → User direkt zum richtigen Setup-Schritt
// schicken. Sonst initCart + render wie bisher.
(async () => {
    let authStatus = null;
    try {
        authStatus = await api.getAuthStatus();
    } catch (err) {
        // Setup-Endpoint unreachable (offline / kaputt) — Fallback: normal weiter
        console.warn('Auth-Status nicht prüfbar:', err);
    }

    if (authStatus && authStatus.require_auth) {
        // Geräte-Link nur einblenden wenn Auth aktiv UND wir auth'd sind
        const navLink = document.querySelector('.nav-geraete');
        if (navLink) navLink.hidden = !authStatus.is_authenticated;

        const path = getRoutePath();
        if (!authStatus.has_admin) {
            // Erst-Setup nötig — egal wo der User hingeht, /setup gewinnt
            if (path !== '/setup') {
                navigate('/setup', true);
                return;
            }
        } else if (!authStatus.is_authenticated && path !== '/setup' && path !== '/pair') {
            // Anonymer Request mit aktivem Auth-Lock → zum Pair-Screen.
            // Der Server hat bereits geprüft ob ein Bearer-Token (aus
            // localStorage) oder ein Session-Cookie (Web-Admin) gültig ist;
            // beides nein heißt: dieser Browser ist nicht eingeloggt.
            navigate('/pair', true);
            return;
        }
    }

    await initCart();
    render();
})();

// Service Worker registrieren — Mount-Point-aware (scope = APP_BASE).
// HTTPS oder localhost ist Voraussetzung; Browser ignoriert die Registration
// stillschweigend wenn nicht erfüllt.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register(APP_BASE + 'sw.js', { scope: APP_BASE })
            .catch((err) => console.warn('Service Worker registration failed:', err));
    });
}
