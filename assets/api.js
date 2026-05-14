import { APP_BASE } from './config.js';

const BASE = APP_BASE + 'api';

// --- Token-Handling (localStorage) ----------------------------------------
const TOKEN_KEY = 'rezepte.auth.token';

export function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
}
export function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

/** Globaler Listener — Views/App können auf "token invalidated" reagieren */
const tokenInvalidListeners = new Set();
export function onTokenInvalid(cb) { tokenInvalidListeners.add(cb); return () => tokenInvalidListeners.delete(cb); }

/** Hängt Authorization-Header an wenn ein Token vorhanden ist */
function withAuth(init = {}) {
    const token = getToken();
    if (!token) return init;
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    return { ...init, headers };
}

async function handle(res) {
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) {
        // 401 → Token war ungültig → lokal löschen, Listener informieren
        if (res.status === 401 && getToken()) {
            clearToken();
            for (const cb of tokenInvalidListeners) {
                try { cb(); } catch (e) { console.error(e); }
            }
        }
        const msg = body?.error || `HTTP ${res.status}`;
        throw new Error(msg);
    }
    return body;
}

/** fetch + auto-injected Authorization-Header wenn ein Token in localStorage liegt */
function authFetch(url, init = {}) {
    return fetch(url, withAuth(init));
}

export const api = {
    async listRezepte({ suche = '', kategorie = '', tag = '' } = {}) {
        const params = new URLSearchParams();
        if (suche) params.set('suche', suche);
        if (kategorie) params.set('kategorie', kategorie);
        if (tag) params.set('tag', tag);
        const qs = params.toString();
        const res = await authFetch(`${BASE}/rezepte.php${qs ? '?' + qs : ''}`);
        return handle(res);
    },

    async getRezept(id) {
        const res = await authFetch(`${BASE}/rezepte.php/${encodeURIComponent(id)}`);
        return handle(res);
    },

    async uploadRezept(file, { dryRun = false } = {}) {
        const fd = new FormData();
        fd.append('datei', file);
        if (dryRun) fd.append('dry_run', '1');
        const res = await authFetch(`${BASE}/upload.php`, { method: 'POST', body: fd });
        return handle(res);
    },

    async uploadRezeptJson(jsonObj, opts = {}) {
        const blob = new Blob([JSON.stringify(jsonObj)], { type: 'application/json' });
        const file = new File([blob], 'rezept.json', { type: 'application/json' });
        return this.uploadRezept(file, opts);
    },

    async updateRezept(id, jsonObj) {
        const res = await authFetch(`${BASE}/rezepte.php/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jsonObj),
        });
        return handle(res);
    },

    async deleteRezept(id) {
        const res = await authFetch(`${BASE}/rezepte.php/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
        return handle(res);
    },

    async einkaufsliste(rezepte, snapshot = {}) {
        const res = await authFetch(`${BASE}/einkaufsliste.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rezepte, snapshot }),
        });
        return handle(res);
    },

    async getCart() {
        const res = await authFetch(`${BASE}/cart.php`);
        return handle(res);
    },

    async putCart(items, snapshot = {}) {
        const res = await authFetch(`${BASE}/cart.php`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items, snapshot }),
        });
        return handle(res);
    },

    async listSavedLists() {
        const res = await authFetch(`${BASE}/saved_lists.php`);
        return handle(res);
    },

    async getSavedList(name) {
        const params = new URLSearchParams({ name });
        const res = await authFetch(`${BASE}/saved_lists.php?${params}`);
        return handle(res);
    },

    async saveCartAs(name, items) {
        const res = await authFetch(`${BASE}/saved_lists.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, items }),
        });
        return handle(res);
    },

    async deleteSavedList(name) {
        const params = new URLSearchParams({ name });
        const res = await authFetch(`${BASE}/saved_lists.php?${params}`, { method: 'DELETE' });
        return handle(res);
    },

    async getChecks() {
        const res = await authFetch(`${BASE}/checks.php`);
        return handle(res);
    },

    async setCheck(kategorie, schluessel, checked) {
        const res = await authFetch(`${BASE}/checks.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kategorie, schluessel, checked }),
        });
        return handle(res);
    },

    async exportCollection() {
        const res = await authFetch(`${BASE}/export.php`);
        return handle(res);
    },

    async importCollection(file, { dryRun = false } = {}) {
        const fd = new FormData();
        fd.append('datei', file);
        if (dryRun) fd.append('dry_run', '1');
        const res = await authFetch(`${BASE}/import.php`, { method: 'POST', body: fd });
        return handle(res);
    },

    async clearChecks(kategorie = '') {
        const url = kategorie
            ? `${BASE}/checks.php?${new URLSearchParams({ kategorie })}`
            : `${BASE}/checks.php`;
        const res = await authFetch(url, { method: 'DELETE' });
        return handle(res);
    },

    // --- Setup / Auth ---------------------------------------------------
    async getAuthStatus() {
        const res = await authFetch(`${BASE}/setup.php?action=status`);
        return handle(res);
    },

    async activateSetup() {
        const res = await authFetch(`${BASE}/setup.php?action=activate`, { method: 'POST' });
        return handle(res);
    },

    async redeemSetupToken(token) {
        const res = await authFetch(`${BASE}/setup.php?action=redeem-setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        });
        return handle(res);
    },

    async listDevices() {
        const res = await authFetch(`${BASE}/auth.php?action=devices`);
        return handle(res);
    },

    async createPairCode(name, typ = 'mobile') {
        const res = await authFetch(`${BASE}/auth.php?action=pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, typ }),
        });
        return handle(res);
    },

    async redeemPairCode(code) {
        const res = await authFetch(`${BASE}/auth.php?action=redeem-pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        return handle(res);
    },

    async revokeDevice(id) {
        const res = await authFetch(`${BASE}/auth.php?action=revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        return handle(res);
    },

    async logout() {
        const res = await authFetch(`${BASE}/auth.php?action=logout`, { method: 'POST' });
        return handle(res);
    },
};
