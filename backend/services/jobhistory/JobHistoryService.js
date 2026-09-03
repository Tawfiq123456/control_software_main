/**
 * JobHistoryService — persistent log of every run.
 *
 * Stored as JSONL at <data>/jobhistory.jsonl. One record per job:
 *   {
 *     id: 'job_<base36 timestamp>',
 *     startedAt: 1719500000000,
 *     endedAt:   1719500300000,
 *     durationMs: 300000,
 *     filename: 'pocket.nc',
 *     gcodeHash: 'sha1...',
 *     gcodeBytes: 14223,
 *     lineCount: 312,
 *     controller: 'GrblHal' | 'RTS' | 'Generic',
 *     outcome:   'ok' | 'fail' | 'aborted',
 *     error:     string|null,
 *     wcs:       'G54',
 *     toolNumber: 1,
 *     feedScale:  100,
 *     spindleRpmMax: 24000,
 *   }
 *
 * REST:
 *   GET    /api/jobhistory?limit=50&from=<ts>&to=<ts>
 *   GET    /api/jobhistory/:id
 *   DELETE /api/jobhistory                (clear all)
 *   DELETE /api/jobhistory/:id
 *
 * Socket.IO:
 *   jobhistory:added  ({record})
 *   jobhistory:list   (sent on connect with last 50)
 *
 * Hooks the controller via getController() to subscribe to:
 *   - 'job:start'  → open a new record
 *   - 'job:end'    → close record + persist
 *   - 'job:error'  → mark fail with error message
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class JobHistoryService extends EventEmitter {
    constructor({ dataDir, io, logger, getController }) {
        super();
        this.dataDir = dataDir;
        this.io = io;
        this.logger = logger || console;
        this.getController = getController;
        this.file = path.join(dataDir, 'jobhistory.jsonl');
        this.records = [];
        this.activeJob = null;
        this._loadFromDisk();
        this._wireController();
    }

    _loadFromDisk() {
        try {
            if (!fs.existsSync(this.file)) return;
            const text = fs.readFileSync(this.file, 'utf8');
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try { this.records.push(JSON.parse(line)); } catch (_) {}
            }
        } catch (e) {
            this.logger.warn?.(`[jobhistory] load failed: ${e.message}`);
        }
    }

    _appendToDisk(record) {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            fs.appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
        } catch (e) {
            this.logger.error?.(`[jobhistory] write failed: ${e.message}`);
        }
    }

    _rewriteDisk() {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            const text = this.records.map(r => JSON.stringify(r)).join('\n') + '\n';
            fs.writeFileSync(this.file, text, 'utf8');
        } catch (e) {
            this.logger.error?.(`[jobhistory] rewrite failed: ${e.message}`);
        }
    }

    _wireController() {
        const ctl = this.getController?.();
        if (!ctl?.on) return;
        ctl.on('job:start', (meta) => this.startJob(meta));
        ctl.on('job:end',   (meta) => this.endJob({ outcome: 'ok', ...meta }));
        ctl.on('job:error', (err)  => this.endJob({ outcome: 'fail', error: err?.message || String(err) }));
        ctl.on('job:abort', ()     => this.endJob({ outcome: 'aborted' }));
    }

    startJob({ filename, gcode, controller, wcs, toolNumber }) {
        const id = 'job_' + Date.now().toString(36);
        const gcodeBuf = typeof gcode === 'string' ? Buffer.from(gcode) : (gcode || Buffer.alloc(0));
        const hash = crypto.createHash('sha1').update(gcodeBuf).digest('hex');
        const lineCount = gcode ? gcode.toString().split('\n').filter(Boolean).length : 0;
        this.activeJob = {
            id,
            startedAt: Date.now(),
            filename: filename || 'untitled.nc',
            gcodeHash: hash,
            gcodeBytes: gcodeBuf.length,
            lineCount,
            controller: controller || 'unknown',
            wcs: wcs || 'G54',
            toolNumber: toolNumber ?? null,
        };
    }

    endJob({ outcome, error }) {
        if (!this.activeJob) return null;
        const r = {
            ...this.activeJob,
            endedAt: Date.now(),
            durationMs: Date.now() - this.activeJob.startedAt,
            outcome: outcome || 'ok',
            error: error || null,
        };
        this.records.push(r);
        this._appendToDisk(r);
        this.io.emit('jobhistory:added', r);
        this.activeJob = null;
        return r;
    }

    list({ limit = 50, from, to } = {}) {
        let arr = this.records.slice();
        if (from) arr = arr.filter(r => r.startedAt >= +from);
        if (to)   arr = arr.filter(r => r.startedAt <= +to);
        arr.sort((a, b) => b.startedAt - a.startedAt);
        return arr.slice(0, +limit);
    }

    get(id) { return this.records.find(r => r.id === id) || null; }

    deleteOne(id) {
        const before = this.records.length;
        this.records = this.records.filter(r => r.id !== id);
        if (this.records.length !== before) this._rewriteDisk();
    }

    clear() {
        this.records = [];
        try { fs.unlinkSync(this.file); } catch (_) {}
    }

    stats() {
        const total = this.records.length;
        const ok = this.records.filter(r => r.outcome === 'ok').length;
        const fail = this.records.filter(r => r.outcome === 'fail').length;
        const aborted = this.records.filter(r => r.outcome === 'aborted').length;
        const totalMs = this.records.reduce((s, r) => s + (r.durationMs || 0), 0);
        return { total, ok, fail, aborted, totalMs };
    }
}

module.exports = { JobHistoryService };
