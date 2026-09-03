/**
 * JobResumeService — wires JobResumeStore to the active controller's
 * sender events so checkpoints are written/cleared automatically.
 *
 * Architecture note:
 *   This service follows the same pattern as JobHistoryService: it receives
 *   a `getController()` factory at construction time and calls it each time
 *   it needs the active controller reference. CNCEngine creates controllers
 *   dynamically on firmware detection, so we hook controller events at the
 *   point the engine signals a new controller is live (via the 'controller'
 *   property changing), not at construction time.
 *
 *   CNCEngine already relays all sender:* events to Socket.IO. We hook the
 *   same events on the controller directly so we don't need to modify
 *   CNCEngine. The attachment happens lazily: the first call to any
 *   checkpoint-writing path checks whether we've attached to the current
 *   controller and re-attaches if not.
 *
 * Checkpoint lifecycle:
 *
 *   gcode:load  ─► pending state saved in memory (not yet on disk)
 *   gcode:start ─► checkpoint written to disk (line 0, job in progress)
 *   progress    ─► checkpoint updated every CHECKPOINT_EVERY_N lines
 *   sender:end  ─► checkpoint CLEARED  (job completed OK — no resume needed)
 *   sender:error─► checkpoint SAVED with last executed line (resume available)
 *   gcode:stop  ─► checkpoint SAVED with last executed line (user aborted)
 *   link lost   ─► checkpoint SAVED with last executed line (power/cable loss)
 *
 *   On next boot: JobResumeService.getCheckpoint() returns the saved record.
 *   Frontend calls POST /api/job/resume → resumeFromCheckpoint() reloads
 *   the G-code and calls gcode:startFromLine(lastExecutedLine + 1).
 */
'use strict';

const { EventEmitter } = require('events');
const { JobResumeStore } = require('./JobResumeStore');

// Save a checkpoint every this many executed lines (in addition to
// save-on-stop/error). Lower = more disk writes but finer granularity.
const CHECKPOINT_EVERY_N = 25;

class JobResumeService extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string}   opts.dataDir        Path to backend/data/
     * @param {object}   opts.io             Socket.IO server
     * @param {object}   [opts.logger]
     * @param {function} opts.getController  Returns active controller or null
     */
    constructor({ dataDir, io, logger, getController }) {
        super();
        this.io            = io;
        this._log          = logger || console;
        this.getController = getController;
        this.store         = new JobResumeStore(dataDir, logger);

        // In-flight state (populated by _onLoad, cleared by _onEnd/_onClear)
        this._pending = null;   // { filename, gcodeText, wcs } — from last gcode:load
        this._active  = null;   // { ...pending, totalLines, lastExecutedLine } — job live
        this._progressCount = 0;

        // Track which controller we've attached listeners to.
        this._attachedController = null;

        // Emit current checkpoint to any client that connects after boot.
        this.io.on('connection', (socket) => {
            const cp = this.store.load();
            if (cp) {
                socket.emit('job:checkpoint', this._checkpointMeta(cp));
            }
        });
    }

    // ------------------------------------------------------------------
    // Called by RSPController (via index.js wiring) when a command fires.
    // index.js hooks these after each gcode:load / gcode:start / gcode:stop.
    // ------------------------------------------------------------------

    /** Called when gcode:load fires — store pending state. */
    onLoad({ filename, gcodeText, wcs }) {
        this._pending = { filename: filename || 'untitled.nc', gcodeText: gcodeText || '', wcs: wcs || 'G54' };
    }

    /** Called when gcode:start fires — write initial checkpoint to disk. */
    onStart({ totalLines } = {}) {
        if (!this._pending) return;
        this._active = {
            ...this._pending,
            totalLines:       totalLines ?? 0,
            lastExecutedLine: 0,
        };
        this._progressCount = 0;
        this._saveActive();
        this._attachController();
    }

    /** Called when gcode:stop fires (user abort). */
    onStop() {
        if (this._active) this._saveActive();
    }

    // ------------------------------------------------------------------
    // Public — REST endpoints call these
    // ------------------------------------------------------------------

    /** @returns {object|null} Full checkpoint record, or null. */
    getCheckpoint() {
        return this.store.load();
    }

    /** @returns {boolean} */
    hasCheckpoint() {
        return this.store.has();
    }

    /**
     * Resume the job from the saved checkpoint.
     * Reloads the G-code via gcode:load and starts from lastExecutedLine + 1.
     *
     * @returns {{ ok: boolean, fromLine?: number, filename?: string, error?: string }}
     */
    resumeFromCheckpoint() {
        const cp = this.store.load();
        if (!cp) return { ok: false, error: 'No resume checkpoint available' };
        if (!cp.gcodeText) return { ok: false, error: 'Checkpoint has no G-code text' };

        const ctl = this.getController?.();
        if (!ctl) return { ok: false, error: 'No active controller' };

        const fromLine = Math.max(1, (cp.lastExecutedLine || 0) + 1);

        this._log.info?.(`[JobResume] Resuming "${cp.filename}" from line ${fromLine} / ${cp.totalLines}`);

        // Restore pending state so onStart() gets the right data when
        // gcode:startFromLine internally fires gcode:load equivalent.
        this._pending = {
            filename:  cp.filename,
            gcodeText: cp.gcodeText,
            wcs:       cp.wcs,
        };

        ctl.command('gcode:load', cp.filename, cp.gcodeText);
        ctl.command('gcode:startFromLine', fromLine);

        this.io.emit('job:resume:start', { filename: cp.filename, fromLine, totalLines: cp.totalLines });

        return { ok: true, fromLine, filename: cp.filename };
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    _saveActive() {
        if (!this._active) return;
        try {
            this.store.save(this._active);
            this.io.emit('job:checkpoint', this._checkpointMeta(this._active));
        } catch (e) {
            this._log.warn?.(`[JobResume] checkpoint save failed: ${e.message}`);
        }
    }

    _checkpointMeta(cp) {
        // Strip gcodeText from the Socket.IO event — can be megabytes.
        const { gcodeText: _, ...meta } = cp;
        return meta;
    }

    /**
     * Attach to the current controller's sender events.
     * Safe to call repeatedly — skips if already attached to this controller.
     */
    _attachController() {
        const ctl = this.getController?.();
        if (!ctl || ctl === this._attachedController) return;

        // Detach from old controller if any.
        this._detachController();
        this._attachedController = ctl;

        // Progress — update lastExecutedLine every N lines.
        this._onProgress = ({ executed, total, lineNo }) => {
            if (!this._active) return;
            this._active.lastExecutedLine = lineNo ?? executed;
            if (this._active.totalLines === 0 && total) this._active.totalLines = total;
            this._progressCount++;
            if (this._progressCount % CHECKPOINT_EVERY_N === 0) {
                this._saveActive();
            }
        };

        // Job completed successfully — clear checkpoint.
        this._onSenderEnd = () => {
            this._log.info?.('[JobResume] Job complete — clearing checkpoint');
            this.store.clear();
            this.io.emit('job:checkpoint', null);
            this._active  = null;
            this._pending = null;
        };

        // Job failed or link lost — save checkpoint for resume.
        this._onSenderError = ({ reason } = {}) => {
            if (this._active) {
                this._log.warn?.(`[JobResume] Job error (${reason}) — checkpoint saved at line ${this._active.lastExecutedLine}`);
                this._saveActive();
            }
        };

        // Link lost (power/cable) — save immediately.
        this._onError = () => {
            if (this._active) {
                this._log.warn?.('[JobResume] Link/controller error — saving checkpoint');
                this._saveActive();
            }
        };

        ctl.on('sender:status', this._onProgress);
        ctl.once('sender:end',  this._onSenderEnd);
        ctl.once('sender:error', this._onSenderError);
        ctl.once('error', this._onError);
    }

    _detachController() {
        const ctl = this._attachedController;
        if (!ctl) return;
        if (this._onProgress)    ctl.off('sender:status', this._onProgress);
        if (this._onSenderEnd)   ctl.off('sender:end',    this._onSenderEnd);
        if (this._onSenderError) ctl.off('sender:error',  this._onSenderError);
        if (this._onError)       ctl.off('error',         this._onError);
        this._attachedController = null;
    }
}

module.exports = { JobResumeService };
