/**
 * LibraryService — persistent storage for user-saved G-code files.
 *
 * Replaces the localStorage-only Library page so designs survive a browser
 * change / cache clear. Tawfiq backend audit msg 7424.
 *
 * Storage:
 *   - Per-file: backend/data/library/<id>/{meta.json, body.gcode}
 *   - Index built on-the-fly from the directory at list() time (no DB)
 *
 * REST routes wired in index.js:
 *   GET    /api/library           → list (id, name, fileName, size, savedAt)
 *   GET    /api/library/:id/body  → raw G-code text
 *   POST   /api/library           → JSON body { name, fileName, body }
 *   DELETE /api/library/:id       → remove
 */
const fs = require('fs');
const path = require('path');

class LibraryService {
    constructor({ dataDir, io, logger }) {
        this.root = path.join(dataDir || path.join(__dirname, '..', '..', 'data'), 'library');
        this.io = io;
        this.log = logger || console;
        try { fs.mkdirSync(this.root, { recursive: true }); }
        catch (err) { this.log.warn?.('library.mkdir.failed', { err: err?.message }); }
    }

    list() {
        const out = [];
        let entries = [];
        try { entries = fs.readdirSync(this.root, { withFileTypes: true }); }
        catch (_) { return out; }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const meta = this._readMeta(e.name);
            if (meta) out.push(meta);
        }
        // Newest first.
        out.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
        return out;
    }

    getBody(id) {
        const file = path.join(this.root, this._safeId(id), 'body.gcode');
        try { return fs.readFileSync(file, 'utf-8'); }
        catch (err) { throw new Error(`Library entry ${id} not found`); }
    }

    upsert({ name, fileName, body }) {
        if (!name || !fileName || typeof body !== 'string') {
            throw new Error('Missing required fields: name, fileName, body');
        }
        const id = `l-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const dir = path.join(this.root, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'body.gcode'), body, 'utf-8');
        const meta = {
            id,
            name: String(name).slice(0, 120),
            fileName: String(fileName).slice(0, 200),
            size: Buffer.byteLength(body, 'utf-8'),
            lineCount: body.split('\n').length,
            savedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
        this.io?.emit?.('library:added', meta);
        return meta;
    }

    remove(id) {
        const dir = path.join(this.root, this._safeId(id));
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (err) { this.log.error?.('library.remove.failed', { id, err: err?.message }); }
        this.io?.emit?.('library:removed', { id });
    }

    // ─── helpers ─────────────────────────────────────────────────

    _readMeta(id) {
        try {
            const raw = fs.readFileSync(path.join(this.root, id, 'meta.json'), 'utf-8');
            const meta = JSON.parse(raw);
            return meta && meta.id ? meta : null;
        } catch (_) { return null; }
    }

    _safeId(id) {
        // Strip anything that isn't id-like to prevent path traversal.
        return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    }
}

module.exports = { LibraryService };
