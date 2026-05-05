const BASE = '/api';

async function handle(res) {
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) {
        const msg = body?.error || `HTTP ${res.status}`;
        throw new Error(msg);
    }
    return body;
}

export const api = {
    async listRezepte({ suche = '', kategorie = '' } = {}) {
        const params = new URLSearchParams();
        if (suche) params.set('suche', suche);
        if (kategorie) params.set('kategorie', kategorie);
        const qs = params.toString();
        const res = await fetch(`${BASE}/rezepte.php${qs ? '?' + qs : ''}`);
        return handle(res);
    },

    async getRezept(id) {
        const res = await fetch(`${BASE}/rezepte.php/${encodeURIComponent(id)}`);
        return handle(res);
    },

    async uploadRezept(file, { dryRun = false } = {}) {
        const fd = new FormData();
        fd.append('datei', file);
        if (dryRun) fd.append('dry_run', '1');
        const res = await fetch(`${BASE}/upload.php`, { method: 'POST', body: fd });
        return handle(res);
    },

    async uploadRezeptJson(jsonObj, opts = {}) {
        const blob = new Blob([JSON.stringify(jsonObj)], { type: 'application/json' });
        const file = new File([blob], 'rezept.json', { type: 'application/json' });
        return this.uploadRezept(file, opts);
    },

    async updateRezept(id, jsonObj) {
        const res = await fetch(`${BASE}/rezepte.php/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jsonObj),
        });
        return handle(res);
    },

    async deleteRezept(id) {
        const res = await fetch(`${BASE}/rezepte.php/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
        return handle(res);
    },

    async einkaufsliste(rezepte) {
        const res = await fetch(`${BASE}/einkaufsliste.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rezepte }),
        });
        return handle(res);
    },
};
