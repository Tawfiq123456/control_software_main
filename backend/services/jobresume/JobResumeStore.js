/**
 * JobResumeStore — atomic, CRC32-protected persistence for job resume
 * checkpoints.
 *
 * Saves exactly one file: <dataDir>/job_resume.json
 * Maintains a backup:    <dataDir>/job_resume.json.bak
 *
 * The checkpoint captures enough state to reload and restart the job
 * from the last successfully executed line — even after a full power loss.
 *
 * Schema v2:
 *   {
 *     version:          2,         // schema version for forward compat
 *     filename:         string,    // original filename shown in UI
 *     gcodeText:        string,    // FULL G-code text (survives USB removal)
 *     gcodeHash:        string,    // sha1 of gcodeText (for integrity check)
 *     totalLines:       number,    // total parsed line count
 *     lastExecutedLine: number,    // last line confirmed executed by firmware
 *     lastConfirmedPos: {x,y,z},  // machine position at last confirmed line
 *     modalState: {               // modal state at checkpoint
 *       wcs:            string,   // active WCS (e.g. 'G54')
 *       units:          string,   // G20/G21
 *       distanceMode:   string,   // G90/G91
 *       feedMode:       string,   // G93/G94
 *       spindleState:   string,   // M3/M4/M5
 *       spindleRpm:     number,
 *       coolantState:   string,   // M7/M8/M9
 *       feedRate:       number,
 *       toolNumber:     number,
 *       feedOverridePct: number,
 *     },
 *     savedAt:          number,   // epoch ms
 *     crc32:            string,   // hex CRC32 of JSON without this field
 *   }
 *
 * Writes are atomic: write to .tmp → fsync → rename over the real file,
 * so a power cut mid-write leaves either the old file intact or the new one
 * complete — never a half-written JSON.
 *
 * A .bak backup is maintained: before overwriting the main file, the current
 * good copy is renamed to .bak. If the main file fails to load (CRC error,
 * corrupt JSON), the .bak is tried as a fallback — at most one checkpoint
 * interval of progress is lost.
 *
 * CRC32 (IEEE 802.3, reflected) is computed over the JSON payload without
 * the crc32 field, using the same algorithm as the RSP frame layer
 * (rsp/frame.js) for consistency.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILENAME     = 'job_resume.json';
const FILENAME_TMP = 'job_resume.json.tmp';
const FILENAME_BAK = 'job_resume.json.bak';

// Current schema version. Bump this when the checkpoint structure changes
// in a way that older code can't load.
const SCHEMA_VERSION = 2;

// --------------------------------------------------------------------------
// CRC32 (IEEE 802.3, reflected) — same table/algorithm as rsp/frame.js
// --------------------------------------------------------------------------
const _CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _CRC_TABLE[i] = c >>> 0;
}

/**
 * @param {Buffer|string} data
 * @returns {string} hex CRC32
 */
function computeCrc32(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = (_CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// Default modal state — used when the caller doesn't provide one.
const DEFAULT_MODAL_STATE = Object.freeze({
    wcs: 'G54',
    units: 'G21',
    distanceMode: 'G90',
    feedMode: 'G94',
    spindleState: 'M5',
    spindleRpm: 0,
    coolantState: 'M9',
    feedRate: 0,
    toolNumber: 0,
    feedOverridePct: 100,
});

class JobResumeStore {
    /**
     * @param {string} dataDir  Absolute path to the backend data directory.
     * @param {object} [logger]
     */
    constructor(dataDir, logger) {
        this.dataDir  = dataDir;
        this.filePath = path.join(dataDir, FILENAME);
        this.tmpPath  = path.join(dataDir, FILENAME_TMP);
        this.bakPath  = path.join(dataDir, FILENAME_BAK);
        this._log     = logger || console;
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Save a checkpoint. Required fields:
     *   filename, gcodeText, totalLines, lastExecutedLine
     * Optional fields:
     *   wcs, lastConfirmedPos, modalState
     *
     * All fields except `savedAt`, `gcodeHash`, `crc32`, and `version` must
     * be supplied by the caller; this method fills in the derived/timestamp/
     * integrity fields.
     *
     * @param {object} data
     */
    save(data) {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });

            const hash = crypto.createHash('sha1')
                .update(data.gcodeText || '')
                .digest('hex');

            // Build the record WITHOUT crc32 first, compute CRC over it,
            // then add crc32 to the final record.
            const recordBase = {
                version:          SCHEMA_VERSION,
                filename:         data.filename        || 'untitled.nc',
                gcodeText:        data.gcodeText       || '',
                gcodeHash:        hash,
                totalLines:       data.totalLines      ?? 0,
                lastExecutedLine: data.lastExecutedLine ?? 0,
                lastConfirmedPos: data.lastConfirmedPos || { x: 0, y: 0, z: 0 },
                modalState:       { ...DEFAULT_MODAL_STATE, ...(data.modalState || {}) },
                savedAt:          Date.now(),
            };

            // CRC32 is computed over the JSON string of the record without crc32
            const jsonForCrc = JSON.stringify(recordBase);
            const crc = computeCrc32(jsonForCrc);

            const record = { ...recordBase, crc32: crc };

            // Atomic write: tmp → fsync → backup old → rename tmp over main.
            const json = JSON.stringify(record, null, 2);
            fs.writeFileSync(this.tmpPath, json, 'utf8');

            // fsync the tmp file so the data is on disk before rename.
            try {
                const fd = fs.openSync(this.tmpPath, 'r+');
                fs.fsyncSync(fd);
                fs.closeSync(fd);
            } catch (_) { /* fsync not critical — best effort */ }

            // Backup: if the main file exists, copy it to .bak BEFORE
            // overwriting. This way, if the rename below fails (power cut),
            // we still have the previous checkpoint in .bak.
            try {
                if (fs.existsSync(this.filePath)) {
                    fs.copyFileSync(this.filePath, this.bakPath);
                }
            } catch (_) { /* backup not critical — best effort */ }

            fs.renameSync(this.tmpPath, this.filePath);

        } catch (e) {
            this._log.error?.(`[JobResumeStore] save failed: ${e.message}`);
        }
    }

    /**
     * Load and parse the stored checkpoint with integrity validation.
     *
     * Validation chain:
     *   1. Parse JSON
     *   2. Verify CRC32 (if present; v1 records without CRC are accepted)
     *   3. Re-hash gcodeText and compare to gcodeHash
     *
     * If the main file fails, tries the .bak backup.
     *
     * @returns {object|null}
     */
    load() {
        // Try main file first.
        const main = this._loadAndValidate(this.filePath);
        if (main) return main;

        // Main file missing or corrupt — try backup.
        const bak = this._loadAndValidate(this.bakPath);
        if (bak) {
            this._log.warn?.('[JobResumeStore] main checkpoint corrupt/missing — recovered from backup');
            // Restore the backup as the main file so future loads don't
            // need to fall back again.
            try {
                fs.copyFileSync(this.bakPath, this.filePath);
            } catch (_) { /* best effort */ }
            return bak;
        }

        return null;
    }

    /**
     * Delete the checkpoint file (and backup). Called when a job completes
     * successfully (no resume needed) or when the user explicitly clears it.
     */
    clear() {
        try {
            if (fs.existsSync(this.filePath))  fs.unlinkSync(this.filePath);
            if (fs.existsSync(this.tmpPath))   fs.unlinkSync(this.tmpPath);
            if (fs.existsSync(this.bakPath))   fs.unlinkSync(this.bakPath);
        } catch (e) {
            this._log.warn?.(`[JobResumeStore] clear failed: ${e.message}`);
        }
    }

    /** @returns {boolean} */
    has() {
        return fs.existsSync(this.filePath) || fs.existsSync(this.bakPath);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /**
     * Load, parse, and validate a single checkpoint file.
     * @param {string} filePath
     * @returns {object|null}
     */
    _loadAndValidate(filePath) {
        try {
            if (!fs.existsSync(filePath)) return null;
            const raw = fs.readFileSync(filePath, 'utf8');
            const record = JSON.parse(raw);

            // ---- CRC32 validation (v2+ records only) ----
            if (record.crc32) {
                // Rebuild the record without crc32 to recompute the hash.
                const { crc32: savedCrc, ...recordWithoutCrc } = record;
                const jsonForCrc = JSON.stringify(recordWithoutCrc);
                const computedCrc = computeCrc32(jsonForCrc);
                if (computedCrc !== savedCrc) {
                    this._log.error?.(
                        `[JobResumeStore] CRC32 mismatch in ${path.basename(filePath)}: ` +
                        `expected ${savedCrc}, got ${computedCrc} — checkpoint rejected`
                    );
                    return null;
                }
            }

            // ---- gcodeHash validation ----
            if (record.gcodeText && record.gcodeHash) {
                const recomputedHash = crypto.createHash('sha1')
                    .update(record.gcodeText)
                    .digest('hex');
                if (recomputedHash !== record.gcodeHash) {
                    this._log.error?.(
                        `[JobResumeStore] gcodeHash mismatch in ${path.basename(filePath)}: ` +
                        `stored=${record.gcodeHash}, computed=${recomputedHash} — checkpoint rejected`
                    );
                    return null;
                }
            }

            // ---- Migrate v1 records to v2 shape ----
            if (!record.version || record.version < SCHEMA_VERSION) {
                record.version = SCHEMA_VERSION;
                if (!record.lastConfirmedPos) record.lastConfirmedPos = { x: 0, y: 0, z: 0 };
                if (!record.modalState) record.modalState = { ...DEFAULT_MODAL_STATE };
                if (record.wcs) {
                    record.modalState.wcs = record.wcs;
                    delete record.wcs;
                }
            }

            return record;
        } catch (e) {
            this._log.warn?.(`[JobResumeStore] load from ${path.basename(filePath)} failed: ${e.message}`);
            return null;
        }
    }
}

module.exports = { JobResumeStore, computeCrc32, DEFAULT_MODAL_STATE, SCHEMA_VERSION };
