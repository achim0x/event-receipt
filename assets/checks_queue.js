// IndexedDB-Queue für abgehakt-Mutationen, damit das Setzen/Entfernen
// von Häkchen offline persistent ist und beim nächsten Online-Wechsel
// automatisch zum Server synchronisiert wird.
//
// Semantik:
//   - Jeder Checkbox-Toggle wird zuerst in die Queue geschrieben
//     (auch online). Wenn online, wird flush() sofort getriggert und
//     die Queue ist meist wieder leer.
//   - Beim Render der Aggregations-View wird der Server-Check-Stand
//     mit den pending entries gemerged (latest-wins pro key), damit
//     die Häkchen im DOM korrekt erscheinen — auch wenn der Sync
//     noch aussteht.
//   - flush() dedupliziert pro (kategorie, schluessel) auf den jüngsten
//     Eintrag, postet diesen zum Server, und löscht bei Erfolg alle
//     entries für diesen Schlüssel aus der Queue.
//   - Bei POST-Fehler bleibt der Eintrag drin — nächste Online-Chance
//     versucht es erneut. Last-Write-Wins passt zum existierenden
//     „shared everything"-Modell.

const DB_NAME = 'rezepte-pwa';
const DB_VERSION = 1;
const STORE = 'pending_checks';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, {
                    keyPath: 'id',
                    autoIncrement: true,
                });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function tx(mode) {
    return openDB().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

function reqToPromise(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Fügt eine Check-Mutation in die Queue. Wird auch online aufgerufen,
 * damit Logik einheitlich ist — flush() nimmt sie dann sofort wieder raus.
 */
export async function enqueue(kategorie, schluessel, checked) {
    const store = await tx('readwrite');
    await reqToPromise(store.add({
        kategorie,
        schluessel,
        checked: !!checked,
        timestamp: Date.now(),
    }));
}

/**
 * Alle pending Einträge in Einfüge-Reihenfolge.
 */
export async function getPending() {
    const store = await tx('readonly');
    return reqToPromise(store.getAll());
}

/**
 * Anzahl pending Einträge — z.B. für UI-Indikatoren.
 */
export async function pendingCount() {
    const store = await tx('readonly');
    return reqToPromise(store.count());
}

/**
 * Merged Server-Check-Antwort mit pending Mutationen. Pro (kategorie, schluessel)
 * gewinnt der jüngste pending-Eintrag — checked → in Set, unchecked → raus.
 * Liefert ein Objekt der gleichen Form wie api.getChecks().
 */
export async function applyPendingToChecks(serverChecks) {
    const pending = await getPending();
    const latestPerKey = new Map();
    for (const p of pending) {
        latestPerKey.set(p.kategorie + '||' + p.schluessel, p);
    }
    const merged = {
        zutaten: new Set(serverChecks?.zutaten || []),
        gewuerze: new Set(serverChecks?.gewuerze || []),
        equipment: new Set(serverChecks?.equipment || []),
    };
    for (const p of latestPerKey.values()) {
        const set = merged[p.kategorie];
        if (!set) continue;
        if (p.checked) set.add(p.schluessel);
        else set.delete(p.schluessel);
    }
    return {
        zutaten: [...merged.zutaten],
        gewuerze: [...merged.gewuerze],
        equipment: [...merged.equipment],
    };
}

/**
 * Versucht pending Einträge zum Server zu pushen. Pro (kategorie, schluessel)
 * wird nur der jüngste Eintrag gepostet (deduplication). Bei Erfolg werden
 * alle entries für den Key gelöscht, bei Fehler bleiben sie für den nächsten
 * Versuch erhalten.
 *
 * @param {object} api - api-Objekt mit setCheck-Methode
 * @returns {{ pushed: number, failed: number, remaining: number }}
 */
export async function flush(api) {
    if (!navigator.onLine) {
        return { pushed: 0, failed: 0, remaining: await pendingCount() };
    }
    const pending = await getPending();
    if (!pending.length) return { pushed: 0, failed: 0, remaining: 0 };

    // Gruppieren nach (kategorie, schluessel)
    const grouped = new Map();
    for (const p of pending) {
        const key = p.kategorie + '||' + p.schluessel;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(p);
    }

    let pushed = 0, failed = 0;

    for (const [key, entries] of grouped) {
        // Letzter Eintrag im Array ist der jüngste (FIFO durch autoIncrement)
        const latest = entries[entries.length - 1];
        try {
            await api.setCheck(latest.kategorie, latest.schluessel, latest.checked);
            // Erfolg → alle Einträge für diesen Key entfernen
            const store = await tx('readwrite');
            for (const e of entries) {
                store.delete(e.id);
            }
            pushed++;
        } catch (err) {
            console.warn('[checks_queue] sync failed for', key, err);
            failed++;
        }
    }

    return { pushed, failed, remaining: await pendingCount() };
}

/**
 * Manueller Reset — komplette Queue leeren (z.B. bei „Häkchen zurücksetzen"
 * sollten auch lokale pending raus, damit der DELETE auf dem Server nicht
 * sofort wieder durch Pending-Sync überschrieben wird).
 */
export async function clearAll() {
    const store = await tx('readwrite');
    await reqToPromise(store.clear());
}
