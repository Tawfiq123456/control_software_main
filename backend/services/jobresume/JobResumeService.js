/**
 * JobResumeService — wires JobResumeStore + RecoveryOrchestrator to the
 * active controller's sender events so checkpoints are written/cleared
 * automatically, and handles the full resume-from-checkpoint flow.
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
 * This is the SINGLE checkpoint owner for all controller types. The old
 * parallel persistence in RSPController (rsp_resume_state.json) has been
 * removed; all checkpoint I/O goes through this service.
 *
 * Checkpoint lifecycle:
 *
 *   gcode:load  ─► pending state saved in memory (not yet on disk)
 *   gcode:start ─► checkpoint written to disk (line 0, job in progress)
 *   progress    ─► checkpoint updated every CHECKPOINT_EVERY_N lines
 *   sender:pause─► checkpoint SAVED immediately (pause = potential resume)
 *   sender:end  ─► checkpoint CLEARED  (job completed OK — no resume needed)
 *   sender:error─► checkpoint SAVED with last executed line (resume available)
 *   gcode:stop  ─► checkpoint SAVED with last executed line (user aborted)
 *   link lost   ─► checkpoint SAVED with last executed line (power/cable loss)
 *
 *   On next boot: JobResumeService.getCheckpoint() returns the saved record.
 *   Frontend calls POST /api/job/resume → resumeFromCheckpoint() reloads
 *   the G-code and calls gcode:startFromLine(lastExecutedLine + 1), with
 *   a modal-state restoration preamble injected first.
 */
'use strict';

const { EventEmitter } = require('events');
const { JobResumeStore } = require('./JobResumeStore');
const { RecoveryOrchestrator } = require('./RecoveryOrchestrator');

// Save a checkpoint every this many executed lines (in addition to
// save-on-stop/error/pause). Lower = more disk writes but finer granularity.
const CHECKPOINT_EVERY_N = 25;

class JobResumeService extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string}   opts.dataDir        Path to backend/data/
     * @param {object}   opts.io             Socket.IO server
     * @param {object}   [opts.logger]
     * @param {function} opts.getController  Returns active controller or null
     * @param {function} [opts.getConfig]    Returns ConfigStore instance or null
     */
    constructor({ dataDir, io, logger, getController, getConfig }) {
        super();
        this.io            = io;
        this._log          = logger || console;
        this.getController = getController;
        this.getConfig     = getConfig || (() => null);
        this.store         = new JobResumeStore(dataDir, logger);

        // In-flight state (populated by _onLoad, cleared by _onEnd/_onClear)
        this._pending = null;   // { filename, gcodeText, modalState } — from last gcode:load
        this._active  = null;   // { ...pending, totalLines, lastExecutedLine, ... } — job live
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
    onLoad({ filename, gcodeText, modalState }) {
        this._pending = {
            filename:   filename || 'untitled.nc',
            gcodeText:  gcodeText || '',
            modalState: modalState || {},
        };
    }

    /** Called when gcode:start fires — write initial checkpoint to disk. */
    onStart({ totalLines, modalState } = {}) {
        if (!this._pending) return;
        this._active = {
            ...this._pending,
            totalLines:        totalLines ?? 0,
            lastExecutedLine:  0,
            lastConfirmedPos:  { x: 0, y: 0, z: 0 },
            modalState:        modalState || this._pending.modalState || {},
        };
        this._progressCount = 0;
        this._saveActive();
        this._attachController();
    }

    /** Called when gcode:stop fires (user abort). */
    onStop() {
        if (this._active) this._saveActive();
    }

    /** Called when gcode:pause fires. */
    onPause() {
        if (this._active) this._saveActive();
    }

    // ------------------------------------------------------------------
    // Public — REST endpoints call these
    // ------------------------------------------------------------------

    /** @returns {object|null} Full checkpoint record, or null. */
    getCheckpoint() {
        return this.store.load();
    }

    /**
     * @returns {object|null} Checkpoint metadata (without gcodeText) for UI display.
     */
    getCheckpointMeta() {
        const cp = this.store.load();
        return cp ? this._checkpointMeta(cp) : null;
    }

    /** @returns {boolean} */
    hasCheckpoint() {
        return this.store.has();
    }

    /**
     * Validate the stored checkpoint.
     * @returns {{ valid: boolean, reason?: string, checkpoint?: object }}
     */
    validateCheckpoint() {
        const cp = this.store.load();
        if (!cp) return { valid: false, reason: 'No checkpoint file found' };
        const result = RecoveryOrchestrator.validateCheckpoint(cp);
        if (result.valid) {
            return { valid: true, checkpoint: this._checkpointMeta(cp) };
        }
        return result;
    }

    /**
     * Resume the job from the saved checkpoint.
     *
     * This is the full resume flow:
     *   1. Load and validate the checkpoint
     *   2. Compute the correct resume line
     *   3. Build the modal-state restoration preamble
     *   4. Load the G-code and start from the resume line
     *
     * @param {object} [opts]
     * @param {boolean} [opts.skipPreamble=false] If true, skip the modal-state preamble
     * @returns {{ ok: boolean, fromLine?: number, filename?: string, preamble?: string[], error?: string }}
     */
    resumeFromCheckpoint(opts = {}) {
        const cp = this.store.load();
        if (!cp) return { ok: false, error: 'No resume checkpoint available' };

        const validation = RecoveryOrchestrator.validateCheckpoint(cp);
        if (!validation.valid) return { ok: false, error: validation.reason };

        const ctl = this.getController?.();
        if (!ctl) return { ok: false, error: 'No active controller' };

        const fromLine = RecoveryOrchestrator.computeResumeLine(cp);

        this._log.info?.(`[JobResume] Resuming "${cp.filename}" from line ${fromLine} / ${cp.totalLines}`);

        // Build the preamble to restore modal state.
        let preamble = [];
        if (!opts.skipPreamble) {
            const config = this.getConfig?.();
            const safeZ = config?.get?.('preferences.safeHeight') ?? 10;
            const currentPos = ctl.state?.status?.mpos || { x: 0, y: 0, z: 0 };
            preamble = RecoveryOrchestrator.buildResumePreamble(cp, currentPos, safeZ);
        }

        // Restore pending state so onStart() gets the right data when
        // gcode:startFromLine internally fires gcode:load equivalent.
        this._pending = {
            filename:   cp.filename,
            gcodeText:  cp.gcodeText,
            modalState: cp.modalState || {},
        };

        // If there's a preamble, prepend it to the G-code before loading.
        // The preamble lines run before the resume point, ensuring modal
        // state is correct.
        let gcodeToLoad = cp.gcodeText;
        if (preamble.length > 0) {
            // Split the original G-code, inject preamble before the resume line,
            // and rejoin. The preamble lines will be treated as "already executed"
            // by the resume(fromLine) logic — they execute at the head of the
            // re-sent stream, before the device reaches the actual resume point.
            //
            // Actually: we prepend the preamble to the FULL gcode text, and adjust
            // the resume line number to account for the added lines.
            const preambleText = preamble.join('\n');
            gcodeToLoad = preambleText + '\n' + cp.gcodeText;
        }

        ctl.command('gcode:load', cp.filename, gcodeToLoad);

        // The adjusted resume line accounts for the preamble lines we added.
        // Lines 1..preamble.length are the preamble (must execute),
        // Lines preamble.length+1..preamble.length+fromLine-1 are the
        // skipped original lines (marked as executed by job.resume()).
        const adjustedFromLine = preamble.length + fromLine;
        ctl.command('gcode:startFromLine', preamble.length > 0 ? adjustedFromLine : fromLine);

        this.io.emit('job:resume:start', {
            filename: cp.filename,
            fromLine,
            totalLines: cp.totalLines,
            preambleLines: preamble.length,
        });

        return { ok: true, fromLine, filename: cp.filename, preamble };
    }

    /**
     * Clear the checkpoint (user decided not to resume).
     */
    clearCheckpoint() {
        this.store.clear();
        this.io.emit('job:checkpoint', null);
        this._active  = null;
        this._pending = null;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    _saveActive() {
        if (!this._active) return;

        // Grab the latest modal state and position from the controller.
        const ctl = this.getController?.();
        if (ctl) {
            if (typeof ctl.getModalState === 'function') {
                this._active.modalState = ctl.getModalState();
            }
            const pos = ctl.state?.status?.mpos;
            if (pos) {
                this._active.lastConfirmedPos = { x: pos.x, y: pos.y, z: pos.z };
            }
        }

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

        // Pause — save checkpoint immediately.
        this._onPause = () => {
            if (this._active) {
                this._log.info?.(`[JobResume] Job paused — checkpoint saved at line ${this._active.lastExecutedLine}`);
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
        ctl.on('sender:pause', this._onPause);
        ctl.once('error', this._onError);
    }

    _detachController() {
        const ctl = this._attachedController;
        if (!ctl) return;
        if (this._onProgress)    ctl.off('sender:status', this._onProgress);
        if (this._onSenderEnd)   ctl.off('sender:end',    this._onSenderEnd);
        if (this._onSenderError) ctl.off('sender:error',  this._onSenderError);
        if (this._onPause)       ctl.off('sender:pause',  this._onPause);
        if (this._onError)       ctl.off('error',         this._onError);
        this._attachedController = null;
    }
}

module.exports = { JobResumeService };
