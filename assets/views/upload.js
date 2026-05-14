import { api } from '../api.js';
import { navigate } from '../app.js';
import { displayUnit } from '../units.js';
import { displayDepartment } from '../aggregate.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function formatQuantity(q) {
    if (q == null || q === '') return '';
    const n = typeof q === 'number' ? q : parseFloat(q);
    if (Number.isNaN(n)) return String(q);
    if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
    return n.toFixed(2).replace(/\.?0+$/, '');
}

export function renderUpload(root) {
    root.innerHTML = `
        <section>
            <h1>Rezept hochladen</h1>
            <p class="muted">Lade eine JSON-Datei mit deutschem oder englischem Schema hoch (max. 1 MB). Einheiten werden automatisch normalisiert (kg→g, L→ml, EL→g, TL→g, Stück→Pcs, Packung→Pck).</p>
            <p class="muted">Du brauchst eine Vorlage? <a href="recipe_template.json" download>📄 recipe_template.json herunterladen</a> — leeres Gerüst mit allen unterstützten Feldern.</p>
            <p class="muted">💡 Tipp: Eine KI kann das JSON aus einer Rezeptseite für dich erzeugen. Lade <code>recipe_template.json</code> bei ChatGPT / Claude / Gemini etc. als Datei mit hoch und nutze einen Prompt wie:</p>
            <div class="prompt-box">
                <code id="ai-prompt-text">Extrahiere das Rezept von dieser Webseite und gib es als JSON exakt nach dem Schema der hochgeladenen recipe_template.json zurück. Normiere dabei alle Zutaten-Mengen auf 1 Person (steht auf der Seite z.B. "für 4 Personen", teile alle Mengen durch 4). Einheiten dürfen g, ml, kg, L, EL, TL, Stück, Stk oder Packung sein — die werden beim Import automatisch normalisiert. Wenn eindeutig zuordenbar, setze pro Zutat ein "department" aus: Obst/Gemüse, Frische Theke, Non-Food, Getränke, Backen, Grundnahrungsmittel — sonst das Feld weglassen. Gib nur das JSON aus, ohne erklärenden Text drumherum.</code>
                <button type="button" class="btn small" id="copy-prompt">📋 Kopieren</button>
            </div>

            <div id="dropzone" class="dropzone">
                <p><strong>JSON-Datei hierher ziehen</strong></p>
                <p class="muted">oder</p>
                <label class="btn">
                    Datei wählen
                    <input type="file" id="file-input" accept="application/json,.json" hidden>
                </label>
            </div>

            <div id="status"></div>
            <div id="preview"></div>

            <details class="bulk-section">
                <summary>📦 Komplette Sammlung verwalten (Export / Batch-Import)</summary>
                <div class="bulk-body">
                    <h3>Exportieren</h3>
                    <p class="muted">Lade alle Rezepte als einzelne JSON-Datei herunter — geeignet als Backup oder fürs Umziehen auf eine andere Installation.</p>
                    <p><a href="api/export.php" download class="btn">📦 Alle Rezepte herunterladen</a></p>

                    <h3>Importieren</h3>
                    <p class="muted">Akzeptiert das vom Export erzeugte Format <code>{recipes: [...]}</code> oder ein nacktes Array von Rezepten. Bestehende Rezepte werden nicht überschrieben — die importierten kommen als neue Einträge dazu. Pro Rezept wird validiert; defekte Einträge werden mit Begründung gemeldet und übersprungen, der Rest landet trotzdem.</p>
                    <div class="bulk-import-row">
                        <input type="file" id="bulk-file" accept="application/json,.json">
                        <button type="button" class="btn needs-network" id="bulk-dryrun">🔍 Prüfen (dry-run)</button>
                        <button type="button" class="btn primary needs-network" id="bulk-import">📥 Importieren</button>
                    </div>
                    <div id="bulk-status"></div>
                </div>
            </details>
        </section>
    `;

    const dz = root.querySelector('#dropzone');
    const fileInput = root.querySelector('#file-input');
    const preview = root.querySelector('#preview');
    const status = root.querySelector('#status');
    const copyPromptBtn = root.querySelector('#copy-prompt');

    copyPromptBtn.addEventListener('click', async () => {
        const text = root.querySelector('#ai-prompt-text').textContent;
        try {
            await navigator.clipboard.writeText(text);
            const original = copyPromptBtn.textContent;
            copyPromptBtn.textContent = '✓ Kopiert';
            setTimeout(() => { copyPromptBtn.textContent = original; }, 1500);
        } catch {
            alert('Kopieren fehlgeschlagen — bitte manuell auswählen.');
        }
    });

    let currentFile = null;
    let currentPreviewObj = null;

    function showStatus(msg, kind = 'info') {
        status.innerHTML = `<p class="${kind}">${escapeHtml(msg)}</p>`;
    }
    function clearStatus() { status.innerHTML = ''; }
    function clearPreview() { preview.innerHTML = ''; currentPreviewObj = null; }

    async function handleFile(file) {
        clearStatus();
        clearPreview();
        currentFile = null;

        if (!file) return;
        if (file.size > 1024 * 1024) {
            showStatus('Datei zu groß (max. 1 MB)', 'error');
            return;
        }

        // Lokaler JSON-Sanity-Check vorab — gibt schnellere Fehlermeldung als der Server-Roundtrip
        let text;
        try {
            text = await file.text();
        } catch {
            showStatus('Datei konnte nicht gelesen werden', 'error');
            return;
        }
        try {
            JSON.parse(text);
        } catch (err) {
            showStatus('Ungültiges JSON: ' + err.message, 'error');
            return;
        }

        currentFile = file;
        showStatus('Validiere…');

        try {
            const result = await api.uploadRezept(file, { dryRun: true });
            currentPreviewObj = result.preview;
            renderPreview(result);
            clearStatus();
        } catch (err) {
            showStatus('Fehler: ' + err.message, 'error');
        }
    }

    function renderPreview({ preview: rezept, warnings }) {
        const ingredients = Array.isArray(rezept.ingredients) ? rezept.ingredients : [];

        const warningsHtml = warnings && warnings.length
            ? `<div class="warning-box">
                  ${warnings.map(w => `
                    <p><strong>⚠ Warnung:</strong> ${escapeHtml(w.message)}</p>
                  `).join('')}
                  <p class="muted">Du kannst trotzdem speichern.</p>
               </div>`
            : '';

        const ingredientsHtml = ingredients.map(g => `
            ${g.group ? `<h4>${escapeHtml(g.group)}</h4>` : ''}
            <ul class="zutaten">
                ${(g.items || []).map(it => {
                    const u = displayUnit(it.unit);
                    const dept = it.department ? ` <span class="dept-tag">${escapeHtml(displayDepartment(it.department))}</span>` : '';
                    return `<li><strong>${escapeHtml(formatQuantity(it.quantity))}${u ? ' ' + escapeHtml(u) : ''}</strong> ${escapeHtml(it.name || '')}${dept}</li>`;
                }).join('')}
            </ul>
        `).join('');

        preview.innerHTML = `
            <div class="preview">
                <h2>Vorschau (nach Normalisierung)</h2>
                ${warningsHtml}
                <dl>
                    <dt>Titel</dt><dd>${escapeHtml(rezept.title || '')}</dd>
                    ${rezept.category ? `<dt>Kategorie</dt><dd>${escapeHtml(rezept.category)}</dd>` : ''}
                    ${rezept.preparation_time ? `<dt>Zubereitungszeit</dt><dd>${escapeHtml(rezept.preparation_time)}</dd>` : ''}
                    ${rezept.source ? `<dt>Quelle</dt><dd>${escapeHtml(rezept.source)}</dd>` : ''}
                </dl>

                ${ingredients.length ? `<h3>Zutaten (Mengen pro Person, Einheiten normalisiert)</h3>${ingredientsHtml}` : ''}

                <details>
                    <summary>Normalisiertes JSON anzeigen</summary>
                    <pre>${escapeHtml(JSON.stringify(rezept, null, 2))}</pre>
                </details>

                <div class="row-buttons">
                    <button type="button" class="btn primary needs-network" id="save-btn">Speichern</button>
                    <button type="button" class="btn" id="cancel-btn">Abbrechen</button>
                </div>
            </div>
        `;

        preview.querySelector('#save-btn').addEventListener('click', save);
        preview.querySelector('#cancel-btn').addEventListener('click', () => {
            fileInput.value = '';
            clearPreview();
            clearStatus();
            currentFile = null;
        });
    }

    async function save() {
        if (!currentFile) return;
        showStatus('Speichere…');
        try {
            const result = await api.uploadRezept(currentFile);
            showStatus(`✓ Gespeichert (ID ${result.id})`, 'success');
            setTimeout(() => navigate(`/rezept/${result.id}`), 500);
        } catch (err) {
            showStatus('Fehler: ' + err.message, 'error');
        }
    }

    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove('drag');
    }));
    dz.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) handleFile(file);
    });

    // --- Bulk Import (Sammlung) ---
    const bulkFile = root.querySelector('#bulk-file');
    const bulkStatus = root.querySelector('#bulk-status');

    async function runBulkImport(dryRun) {
        const file = bulkFile.files[0];
        if (!file) {
            bulkStatus.innerHTML = `<p class="error">Bitte zuerst eine Datei wählen.</p>`;
            return;
        }
        bulkStatus.innerHTML = `<p class="muted">${dryRun ? 'Prüfe…' : 'Importiere…'}</p>`;
        try {
            const result = await api.importCollection(file, { dryRun });
            const headline = dryRun
                ? `${result.imported} von ${result.total} Rezepten wären importierbar`
                : `✓ ${result.imported} von ${result.total} Rezepten importiert`;

            let html = `<p class="${result.imported === result.total ? 'success' : 'info'}">${escapeHtml(headline)}</p>`;
            if (result.failed && result.failed.length) {
                html += `<details open class="bulk-failed">
                    <summary>${result.failed.length} ${result.failed.length === 1 ? 'Fehler' : 'Fehler'}</summary>
                    <ul>`;
                for (const f of result.failed) {
                    html += `<li>#${f.index} <strong>${escapeHtml(f.title)}</strong>: ${escapeHtml(f.error)}</li>`;
                }
                html += `</ul></details>`;
            }
            bulkStatus.innerHTML = html;
        } catch (err) {
            bulkStatus.innerHTML = `<p class="error">Fehler: ${escapeHtml(err.message)}</p>`;
        }
    }

    root.querySelector('#bulk-dryrun').addEventListener('click', () => runBulkImport(true));
    root.querySelector('#bulk-import').addEventListener('click', () => runBulkImport(false));
}
