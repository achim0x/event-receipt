import { renderRezeptListe, renderRezeptDetail, renderRezeptEdit } from './views/rezepte.js';
import { renderUpload } from './views/upload.js';
import { renderEinkaufsliste } from './views/einkaufsliste.js';

const STORAGE_KEY = 'rezepte.einkaufsliste.v1';

const state = {
    einkaufsliste: loadCart(),
};

function loadCart() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function saveCart() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.einkaufsliste));
    updateBadge();
}

function updateBadge() {
    const badge = document.getElementById('cart-badge');
    if (!badge) return;
    const count = state.einkaufsliste.length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
}

export const cart = {
    all: () => state.einkaufsliste.slice(),
    has: (id) => state.einkaufsliste.some(r => r.id === id),
    add(rezept, personen = 1) {
        if (cart.has(rezept.id)) return false;
        state.einkaufsliste.push({
            id: rezept.id,
            titel: rezept.titel,
            personen: Math.max(1, parseInt(personen, 10) || 1),
        });
        saveCart();
        return true;
    },
    remove(id) {
        state.einkaufsliste = state.einkaufsliste.filter(r => r.id !== id);
        saveCart();
    },
    setPersonen(id, personen) {
        const entry = state.einkaufsliste.find(r => r.id === id);
        if (!entry) return;
        entry.personen = Math.max(1, parseInt(personen, 10) || 1);
        saveCart();
    },
    clear() {
        state.einkaufsliste = [];
        saveCart();
    },
};

const routes = [
    { pattern: /^\/$/, handler: () => renderRezeptListe(app) },
    { pattern: /^\/rezept\/(\d+)\/bearbeiten$/, handler: (m) => renderRezeptEdit(app, parseInt(m[1], 10)) },
    { pattern: /^\/rezept\/(\d+)$/, handler: (m) => renderRezeptDetail(app, parseInt(m[1], 10)) },
    { pattern: /^\/upload$/, handler: () => renderUpload(app) },
    { pattern: /^\/einkaufsliste$/, handler: () => renderEinkaufsliste(app) },
];

const app = document.getElementById('app');

function navigate(path, replace = false) {
    if (replace) {
        history.replaceState({}, '', path);
    } else {
        history.pushState({}, '', path);
    }
    render();
}

function render() {
    const path = location.pathname;
    for (const { pattern, handler } of routes) {
        const m = path.match(pattern);
        if (m) {
            handler(m);
            return;
        }
    }
    app.innerHTML = `<div class="empty"><h2>404 — Seite nicht gefunden</h2><p><a href="/" data-link>Zurück zur Übersicht</a></p></div>`;
}

document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-link]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('http')) return;
    e.preventDefault();
    navigate(href);
});

window.addEventListener('popstate', render);

export { navigate };

updateBadge();
render();
