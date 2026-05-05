import { api } from '../api.js';
import { navigate } from '../app.js';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

export function renderUpload(root) {
    root.innerHTML = `
        <section>
            <h1>Rezept hochladen</h1>
            <p class="muted">Lade eine JSON-Datei mit deutschem oder englischem Schema hoch (max. 1 MB).</p>

            <div id="dropzone" class="dropzone">
                <p><strong>JSON-Datei hierher ziehen</strong></p>
                <p class="muted">oder</p>
                <label class="btn">
                    Datei wählen
                    <input type="file" id="file-input" accept="application/json,.json" hidden>
                </label>
            </div>

            <div id="preview"></div>
            <div id="status"></div>
        </section>
    `;

    const dz = root.querySelector('#dropzone');
    const fileInput = root.querySelector('#file-input');
    const preview = root.querySelector('#preview');
    const status = root.querySelector('#status');

    let parsed = null;

    function showStatus(msg, kind = 'info') {
        status.innerHTML = `<p class="${kind}">${escapeHtml(msg)}</p>`;
    }
    function clearStatus() { status.innerHTML = ''; }

    async function handleFile(file) {
        clearStatus();
        preview.innerHTML = '';
        parsed = null;

        if (!file) return;
        if (file.size > 1024 * 1024) {
            showStatus('Datei zu groß (max. 1 MB)', 'error');
            return;
        }
        let text;
        try {
            text = await file.text();
        } catch (err) {
            showStatus('Datei konnte nicht gelesen werden', 'error');
            return;
        }
        let obj;
        try {
            obj = JSON.parse(text);
        } catch (err) {
            showStatus('Ungültiges JSON: ' + err.message, 'error');
            return;
        }

        parsed = { file, obj };
        renderPreview(obj);
    }

    function renderPreview(obj) {
        const titel = obj.title ?? obj.titel ?? '(ohne Titel)';
        const kat = obj.category ?? obj.kategorie ?? '';
        const zeit = obj.preparation_time ?? obj.zubereitungszeit ?? '';
        const ingredients = obj.ingredients ?? obj.zutaten ?? [];
        const ingredientCount = Array.isArray(ingredients)
            ? ingredients.reduce((sum, g) => sum + (Array.isArray(g.items ?? g.zutaten) ? (g.items ?? g.zutaten).length : 0), 0)
            : 0;

        preview.innerHTML = `
            <div class="preview">
                <h2>Vorschau</h2>
                <dl>
                    <dt>Titel</dt><dd>${escapeHtml(titel)}</dd>
                    ${kat ? `<dt>Kategorie</dt><dd>${escapeHtml(kat)}</dd>` : ''}
                    ${zeit ? `<dt>Zubereitungszeit</dt><dd>${escapeHtml(zeit)}</dd>` : ''}
                    <dt>Zutaten</dt><dd>${ingredientCount} Einträge</dd>
                </dl>
                <details>
                    <summary>Rohes JSON anzeigen</summary>
                    <pre>${escapeHtml(JSON.stringify(obj, null, 2))}</pre>
                </details>
                <button type="button" class="btn primary" id="upload-btn">Rezept speichern</button>
            </div>
        `;

        preview.querySelector('#upload-btn').addEventListener('click', upload);
    }

    async function upload() {
        if (!parsed) return;
        showStatus('Lade hoch…');
        try {
            const result = await api.uploadRezept(parsed.file);
            showStatus(`✓ Gespeichert (ID ${result.id})`, 'success');
            setTimeout(() => navigate(`/rezept/${result.id}`), 600);
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
}
