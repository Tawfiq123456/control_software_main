/**
 * JobResumeStore — atomic persistence for job resume checkpoints.
 *
 * Saves exactly one file: <dataDir>/job_resume.json
 *
 * The checkpoint captures enough state to reload and restart the job
 * from the last successfully executed line — even after a full power loss.
 *
 * Schema:
 *   {
 *     filename:        string,   // original filename shown in UI
 *     gcodeText:       string,   // FULL G-code text (survives USB removal)
 *     gcodeHash:       string,   // sha1 of gcodeText (for integrity check)
 *     totalLines:      number,   // total parsed line count
 *     lastExecutedLine:number,   // last line confirmed executed by firmware
 *     wcs:             string,   // active WCS at job start (e.g. 'G54')
 *     savedAt:         number,   // epoch ms
 *   }
 *
 * Writes are atomic: write to .tmp → fsync → rename over the real file,
 * so a power cut mid-write leaves either the old file intact or the new one
 * complete — never a half-written JSON.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILENAME     = 'job_resume.json';
const FILENAME_TMP = 'job_resume.json.tmp';

class JobResumeStore {
    /**
     * @param {string} dataDir  Absolute path to the backend data directory.
     * @param {object} [logger]
     */
    constructor(dataDir, logger) {
        this.dataDir  = dataDir;
        this.filePath = path.join(dataDir, FILENAME);
        this.tmpPath  = path.join(dataDir, FILENAME_TMP);
        this._log     = logger || console;
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Save a checkpoint. Fields:
     *   filename, gcodeText, totalLines, lastExecutedLine, wcs
     *
     * All fields except `savedAt` and `gcodeHash` must be supplied by the
     * caller; this method fills in the derived/timestamp fields.
     *
     * @param {object} data
     */
    save(data) {
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });

            const hash = crypto.createHash('sha1')
                .update(data.gcodeText || '')
                .digest('hex');

            const record = {
                filename:         data.filename        || 'untitled.nc',
                gcodeText:        data.gcodeText       || '',
                gcodeHash:        hash,
                totalLines:       data.totalLines      ?? 0,
                lastExecutedLine: data.lastExecutedLine ?? 0,
                wcs:              data.wcs              || 'G54',
                savedAt:          Date.now(),
            };

            // Atomic write: tmp → rename.
            fs.writeFileSync(this.tmpPath, JSON.stringify(record, null, 2), 'utf8');
            try {
                // fsync the tmp file so the data is on disk before rename.
                const fd = fs.openSync(this.tmpPath, 'r+');
                fs.fsyncSync(fd);
                fs.closeSync(fd);
            } catch (_) { /* fsync not critical — best effort */ }
            fs.renameSync(this.tmpPath, this.filePath);

        } catch (e) {
            this._log.error?.(`[JobResumeStore] save failed: ${e.message}`);
        }
    }

    /**
     * Load and parse the stored checkpoint.
     * @returns {object|null}
     */
    load() {
        try {
            if (!fs.existsSync(this.filePath)) return null;
            const raw = fs.readFileSync(this.filePath, 'utf8');
            return JSON.parse(raw);
        } catch (e) {
            this._log.warn?.(`[JobResumeStore] load failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Delete the checkpoint file. Called when a job completes successfully
     * (no resume needed).
     */
    clear() {
        try {
            if (fs.existsSync(this.filePath))  fs.unlinkSync(this.filePath);
            if (fs.existsSync(this.tmpPath))   fs.unlinkSync(this.tmpPath);
        } catch (e) {
            this._log.warn?.(`[JobResumeStore] clear failed: ${e.message}`);
        }
    }

    /** @returns {boolean} */
    has() {
        return fs.existsSync(this.filePath);
    }
}

module.exports = { JobResumeStore };
