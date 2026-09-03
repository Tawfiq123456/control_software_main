/**
 * RSPController - AXIO controller for the custom RSP (Reliable Stream
 * Protocol) firmware from fw_m3_control_sw (0x7E-framed, CRC32-checked,
 * ARQ-reliable binary protocol over USB-CDC).
 *
 * Wraps rsp/stream.js (ReliableStream) + rsp/job.js (JobStream) behind the
 * same controller interface CNCEngine.js expects of every controller
 * (GenericController.js is the structural template; RTSController.js is
 * the reference for the crash-guard pattern below -- see comments).
 *
 * CRASH-SAFETY CONTRACT (read before touching this file):
 * CNCEngine.js calls several controller members WITHOUT any try/catch or
 * existence guard at some call sites (grepped directly from CNCEngine.js):
 *   - controller.state.status / controller.state.parserstate  (unguarded
 *     property access inside the 'status'/'parserstate' event relays)
 *   - controller.debugMonitor.getEntries(count, type)          (socket
 *     'debug:getEntries' handler, no try/catch)
 *   - controller.healthMonitor.recordPong()                    (socket
 *     'hPing' handler, no try/catch)
 *   - controller.getEventTriggers()                            (socket
 *     'trigger:list' handler, no try/catch)
 *   - controller.write(data, context) / controller.writeln(...)  (called
 *     with only `if (!this.controller) return;` -- no try/catch)
 * Every one of those MUST exist and MUST NOT throw, even before bind()
 * has run or after unbind() has cleared state, or an uncaught exception
 * inside a bare socket.on() handler kills the whole Node process. This is
 * exactly the crash-bug class a prior port of this controller found and
 * fixed -- do not reintroduce it by lazily returning undefined/null for
 * any of the five items above.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const logger = require('../../logger');
const defs = require('../rsp/defs');
const codec = require('../rsp/codec');
const { ReliableStream, LinkLost } = require('../rsp/stream');
const { JobStream } = require('../rsp/job');

// Power-cut survival (Tawfiq msg11347 item 2): a single-record JSON file
// tracking the resume point of whatever job was running. Written
// periodically during a run and on gcode:stop, read once at controller
// construction (a fresh RSPController is built per connection -- see
// services/controllers/index.js's createController() -- so this fires
// right after a backend restart, which is exactly when in-memory
// _resumeLine/_resumeGcode has been lost). Not a queue/history -- job.js
// stays 100% in-memory; this is the one exception, deliberately minimal.
const RESUME_STATE_PATH = path.join(__dirname, '..', '..', 'data', 'rsp_resume_state.json');
// Persisting on every executed line would mean a sync fs.writeFileSync per
// line on the hot progress path; a crash between writes only costs this
// many lines of resume accuracy, which is an acceptable tradeoff.
const RESUME_PERSIST_EVERY_N_LINES = 20;

// --------------------------------------------------------------------------
// Axis encoding assumption (NOT explicitly defined anywhere in the ported
// Python reference -- defs.py/codec.py treat `axis` as an opaque u8).
// Standard 0=X/1=Y/2=Z convention assumed here, matching the ordering used
// throughout fw_m3_control_sw's own X/Y/Z field ordering (Telemetry.x/y/z,
// build_move's x,y,z,feed argument order). UNVERIFIED against the actual
// firmware C source (fw_m3/Src/*.c) -- flagged in BUILD_REPORT.md as a gap
// to confirm against real hardware/firmware source before shipping to a
// real board.
// --------------------------------------------------------------------------
const AXIS_X = 0;
const AXIS_Y = 1;
const AXIS_Z = 2;
const AXIS_BIT_X = 0x01;
const AXIS_BIT_Y = 0x02;
const AXIS_BIT_Z = 0x04;
const AXIS_MASK_ALL = AXIS_BIT_X | AXIS_BIT_Y | AXIS_BIT_Z;

const FEED_OVERRIDE_MIN = 50.0;
const FEED_OVERRIDE_MAX = 150.0;
const FEED_OVERRIDE_COARSE = 10.0;
const FEED_OVERRIDE_FINE = 1.0;

/**
 * Transport adapter bridging AXIO's Connection (rawData events / writeRaw)
 * to the ReliableStream transport contract:
 *   send(buffer), on('data', cb), on('error', cb), close(), reconnect()?
 */
class ConnectionTransport extends EventEmitter {
    constructor(connection) {
        super();
        this._connection = connection;
        this._onRawData = (buf) => this.emit('data', buf);
        this._onError = (err) => this.emit('error', err);
        this._connection.on('rawData', this._onRawData);
        this._connection.on('error', this._onError);
    }

    send(buffer) {
        // connection.writeRaw() already no-ops safely if the underlying
        // port isn't open -- but a closed/torn-down connection during an
        // in-flight retransmit tick must not throw synchronously out of
        // stream.js's tick handler either way, so double-guard here.
        if (!this._connection || !this._connection.isOpen) {
            throw new Error('connection not open');
        }
        this._connection.writeRaw(buffer);
    }

    close() {
        if (this._connection) {
            this._connection.removeListener('rawData', this._onRawData);
            this._connection.removeListener('error', this._onError);
        }
        this._connection = null;
    }

    // no reconnect() -- Connection.js owns reconnect/open lifecycle;
    // ReliableStream's reconnect-attempt path is guarded with typeof and
    // simply skipped when absent.
}

class RSPController extends EventEmitter {
    /**
     * @param {string} [type='RSP']
     */
    constructor(type = 'RSP') {
        super();
        this.type = type;

        /** @type {import('../Connection').Connection|null} */
        this.connection = null;
        this.bound = false;

        /** @type {ConnectionTransport|null} */
        this._transport = null;
        /** @type {ReliableStream|null} */
        this.stream = null;
        /** @type {JobStream|null} */
        this.job = null;
        // Line number of the most recently executed job line -- mirrors what
        // GRBLController's Sender.js calls `received`. Used by getSenderStatus()
        // for the initial-sync sender:status emit.
        this._currentLine = 0;

        // Always a real object -- CNCEngine.js reads controller.state.status
        // / controller.state.parserstate unguarded from its 'status' and
        // 'parserstate' event relays (see file header). Never let this be
        // null/undefined, even pre-bind.
        this.state = {
            status: { activeState: 'Unknown', mpos: { x: 0, y: 0, z: 0 }, feedrate: 0, spindle: 0 },
            parserstate: { modal: {}, feedrate: 0, spindle: 0 },
        };

        // Stub subsystems CNCEngine.js calls unconditionally from bare
        // socket handlers (no try/catch, no typeof guard) -- see file
        // header. RSP has no real debug-entry ring buffer or ping/pong
        // health monitor of its own, so these are minimal-but-real,
        // never-throwing implementations rather than omissions.
        this._debugLog = [];
        this.debugMonitor = {
            getEntries: (count, type) => {
                let entries = this._debugLog;
                if (type) entries = entries.filter((e) => e.type === type);
                if (typeof count === 'number' && count > 0) entries = entries.slice(-count);
                return entries;
            },
        };
        this._lastPongAt = 0;
        this.healthMonitor = {
            recordPong: () => { this._lastPongAt = Date.now(); },
        };

        this._eventTriggers = {};

        // job load/run bookkeeping
        this._loadedGcode = '';
        this._loadedName = '';
        // Resume-after-stop bookkeeping (Tawfiq msg11237: "if started job and
        // stopped it should continue from where it stopped"). _resumeLine is
        // the first not-yet-executed line at the moment gcode:stop was
        // pressed; _resumeGcode is the exact gcode text that was running, so
        // a later gcode:start only resumes if it's the SAME file still
        // loaded -- loading a different file (or the same file finishing
        // cleanly) clears it, so a genuinely new run always starts at line 1.
        this._resumeLine = 0;
        this._resumeGcode = null;
        // Disk-recovered resume record (if any), consumed by the FIRST
        // gcode:load this instance sees. Not applied yet here -- we don't
        // have loaded gcode content to hash-match against until then.
        this._diskResumeRecord = this._loadResumeStateFromDisk();
        this._diskResumeConsumed = false;
        this._feedOverridePct = 100.0;
        this._debugEnabled = false;

        this._bindJobListeners = this._bindJobListeners.bind(this);
    }

    // ------------------------------------------------------------------
    // lifecycle
    // ------------------------------------------------------------------
    /**
     * @param {import('../Connection').Connection} connection
     */
    bind(connection) {
        if (this.bound) {
            logger.warn('[RSP] Controller already bound, unbinding first');
            this.unbind();
        }
        if (!connection) {
            logger.error('[RSP] bind() called with no connection');
            return;
        }

        this.connection = connection;
        this.bound = true;

        this._transport = new ConnectionTransport(connection);
        this.stream = new ReliableStream(this._transport, {
            // NOTE: winston's default console format (winston.format.simple())
            // does not render extra positional args as "splat" text -- calling
            // logger.info('[RSP]', msg) silently drops `msg` from the printed
            // line (found while diagnosing the lossy-link stress test: log
            // lines showed as bare "[RSP] {json meta}" with the actual
            // message missing). Fold everything into one template string.
            logger: {
                debug: () => {},
                info: (...a) => logger.info(`[RSP] ${a.join(' ')}`),
                warn: (...a) => logger.warn(`[RSP] ${a.join(' ')}`),
                error: (...a) => logger.error(`[RSP] ${a.join(' ')}`),
            },
        });
        this.stream.on('status', (dict) => this._onTelemetry(dict));
        this.stream.on('link', (ok) => this._onLinkChange(ok));
        this.stream.on('event', (f) => this._onStreamEvent(f));

        this.job = new JobStream(this.stream, {
            logger: {
                debug: () => {},
                info: (...a) => logger.info(`[RSP job] ${a.join(' ')}`),
                warn: (...a) => logger.warn(`[RSP job] ${a.join(' ')}`),
                error: (...a) => logger.error(`[RSP job] ${a.join(' ')}`),
            },
        });
        this._bindJobListeners();

        this.stream.start();

        logger.info('[RSP] Controller bound and stream started');
        this.emit('initialized', { firmwareType: this.type, firmwareVersion: 'RSP/fw_m3' });
        this.connection.emitToSockets('controller:type', this.type);
        this.connection.emitToSockets('controller:initialized', {
            firmwareType: this.type,
            firmwareVersion: 'RSP (Reliable Stream Protocol)',
        });
    }

    // ------------------------------------------------------------------
    // resume-state persistence (power-cut survival, item 2)
    // ------------------------------------------------------------------
    _gcodeHash(text) {
        return crypto.createHash('sha1').update(text || '').digest('hex');
    }

    _loadResumeStateFromDisk() {
        try {
            if (!fs.existsSync(RESUME_STATE_PATH)) return null;
            const rec = JSON.parse(fs.readFileSync(RESUME_STATE_PATH, 'utf8'));
            if (rec && typeof rec.gcodeHash === 'string' && typeof rec.resumeLine === 'number') return rec;
            return null;
        } catch (e) {
            logger.warn(`[RSP] resume-state load failed: ${e.message}`);
            return null;
        }
    }

    _persistResumeState(line) {
        if (!this._loadedGcode || !(line > 1)) return;
        try {
            fs.mkdirSync(path.dirname(RESUME_STATE_PATH), { recursive: true });
            const rec = {
                name: this._loadedName,
                gcodeHash: this._gcodeHash(this._loadedGcode),
                resumeLine: line,
                updatedAt: Date.now(),
            };
            fs.writeFileSync(RESUME_STATE_PATH, JSON.stringify(rec), 'utf8');
        } catch (e) {
            logger.warn(`[RSP] resume-state write failed: ${e.message}`);
        }
    }

    _clearResumeState() {
        try { fs.unlinkSync(RESUME_STATE_PATH); } catch (_) { /* nothing to clear */ }
    }

    _bindJobListeners() {
        if (!this.job) return;
        this.job.on('progress', ({ executed, total, lineNo }) => {
            // Emit under the same field names GRBLController/Sender.js uses
            // (received/total/progress) instead of RSP-only names -- the
            // frontend's sender:status listener (backendConnection.ts) reads
            // status.received to drive the current-line highlight and
            // status.progress for the job progress bar, shared across both
            // controller types. Previously this emitted {executed,total,
            // remaining}, which don't exist on SenderStatus, so the
            // highlight/progress bar silently never updated on RSP boards.
            this._currentLine = lineNo;
            this.emit('sender:status', {
                total,
                sent: executed,
                received: lineNo,
                progress: total > 0 ? Math.round((executed / total) * 100) : 0,
                remaining: Math.max(0, total - executed),
            });
            // Power-cut survival: a hard crash/power-loss never reaches
            // gcode:stop, so the resume point also has to be checkpointed
            // periodically while the job is running, not only on a clean
            // stop.
            if (executed % RESUME_PERSIST_EVERY_N_LINES === 0) {
                this._persistResumeState(lineNo);
            }
        });
        this.job.on('done', ({ jobId, failReason }) => {
            if (failReason) {
                this.emit('sender:error', { jobId, reason: failReason });
                this.emit('error', new Error(`RSP job ${jobId} failed: ${failReason}`));
            } else {
                // Clean finish -- clear any resume point so a later START on
                // the same file runs from line 1, not "resume from the end".
                this._resumeLine = 0;
                this._resumeGcode = null;
                this._clearResumeState();
                this.emit('sender:end', { jobId });
            }
        });
        this.job.on('aborted', () => {
            this.emit('sender:end', { aborted: true });
        });
        this.job.on('failed', (reason) => {
            // A link-loss/stall failure never reaches gcode:stop's explicit
            // stopLine capture, and may land between two periodic
            // RESUME_PERSIST_EVERY_N_LINES checkpoints -- persist right now
            // so a reconnect + reload offers resume as close to the real
            // stop point as possible, not up to N lines stale.
            const stopLine = this.job ? this.job.nextLineToRun() : 0;
            if (stopLine > 1) {
                this._resumeLine = stopLine;
                this._resumeGcode = this._loadedGcode;
                this._persistResumeState(stopLine);
            }
            this.emit('sender:error', { reason });
        });
    }

    /**
     * Called by CNCEngine._onConnectionClose() BEFORE unbind() when the raw
     * OS-level serial port itself drops (cable pull, driver hiccup, Windows
     * USB power-saving) -- a structurally different failure than the
     * RSP-protocol link-loss job.js's LINK_GRACE_S already handles, since
     * here the transport is gone outright, not just quiet. There's nothing
     * to wait out, so unlike the job.js grace period this reports
     * immediately -- but it still owes the same "don't lose more progress
     * than necessary" duty: checkpoint the resume point right now instead
     * of leaving it to the periodic per-N-lines save, which may be stale.
     * @returns {{jobWasActive: boolean, resumeLine: number}}
     */
    notifyConnectionLost() {
        const jobWasActive = !!(this.job && this.job.active);
        let resumeLine = 0;
        if (jobWasActive) {
            resumeLine = this.job.nextLineToRun();
            if (resumeLine > 1) {
                this._resumeLine = resumeLine;
                this._resumeGcode = this._loadedGcode;
                this._persistResumeState(resumeLine);
            }
        }
        return { jobWasActive, resumeLine };
    }

    unbind() {
        if (this.job) {
            try { this.job.destroy(); } catch (_) { /* never throw from unbind */ }
        }
        if (this.stream) {
            try { this.stream.close(); } catch (_) { /* never throw from unbind */ }
        }
        if (this._transport) {
            try { this._transport.close(); } catch (_) { /* never throw from unbind */ }
        }
        this.job = null;
        this.stream = null;
        this._transport = null;
        this.connection = null;
        this.bound = false;
        this.emit('close');
    }

    destroy() {
        this.unbind();
        this.removeAllListeners();
    }

    // ------------------------------------------------------------------
    // inbound: telemetry / link / events
    // ------------------------------------------------------------------
    _onTelemetry(dict) {
        // RSP has no WCS/G54 offset table -- confirmed against real firmware
        // source (fw_m3/Src/easycnc_protocol.c:776-779, handle_jog_cmd() doc
        // comment): "cur_x/cur_y/cur_z ARE both machine position and work
        // position simultaneously ... mpos and wpos are always identical
        // here." OP_ZERO redefines the coordinate directly rather than
        // subtracting an offset, so wpos is not a separate computed value --
        // it's the same telemetry position mirrored under both keys, purely
        // so the frontend's existing wpos/mpos-keyed rendering path (shared
        // with GRBL/RTS controllers, which DO have a real WCO) has something
        // to read for RSP too.
        const pos = { x: dict.x, y: dict.y, z: dict.z };
        this.state.status = {
            activeState: dict.state_name,
            state: dict.state,
            mpos: pos,
            wpos: pos,
            feedrate: dict.feed,
            spindle: dict.spindle_speed,
            bufferFillPct: dict.buffer_fill_pct,
            plannerDepth: dict.planner_depth,
            linkOk: !!dict.link_ok,
            errorCode: dict.error_code,
            jobActive: dict.job_active,
            feedHold: dict.feed_hold,
            estop: dict.estop_active,
            feedOverridePct: this._feedOverridePct,
        };
        this.state.parserstate.feedrate = dict.feed;
        this.state.parserstate.spindle = dict.spindle_speed;
        if (this.job && this.job.active) {
            // EV_EXECUTED is fire-and-forget/lossy (see job.js noteProgress
            // doc) -- telemetry's last_executed_line is the ground truth
            // that self-heals past any dropped event.
            this.job.noteProgress(dict.last_executed_line);
        }
        this.emit('status', this.state.status);
    }

    _onLinkChange(ok) {
        const msg = ok ? 'RSP link up' : 'RSP link lost';
        logger.info(`[RSP] ${msg}`);
        this._debugLog.push({ type: 'link', ts: Date.now(), ok });
        if (this.connection) this.connection.emitToSockets('serialport:read', msg);
        this.emit('console', msg);
        if (!ok) {
            this.emit('error', new Error(msg));
        }
    }

    _onStreamEvent(f) {
        if (!f || !f.payload || !f.payload.length) return;
        const op = f.payload[0];
        try {
            if (op === defs.EV_FAULT) {
                const { axis, code } = codec.parseEvFault(f.payload.subarray(1));
                logger.warn(`[RSP] EV_FAULT axis=${axis} code=${code}`);
                this.emit('alarm', { type: 'fault', axis, code });
            } else if (op === defs.EV_ESTOP) {
                logger.warn('[RSP] EV_ESTOP received');
                this.emit('alarm', { type: 'estop' });
            } else if (op === defs.EV_COMM_LOST) {
                logger.warn('[RSP] EV_COMM_LOST received (device entered safe-stop)');
                this.emit('alarm', { type: 'comm_lost' });
            }
            // EV_EXECUTED / EV_JOB_DONE / EV_STATUS are consumed internally
            // by job.js / the stream's 'status' event respectively.
        } catch (exc) {
            logger.warn(`[RSP] error handling stream event: ${exc.message || exc}`);
        }
    }

    // ------------------------------------------------------------------
    // outbound: write / writeln (console passthrough)
    // ------------------------------------------------------------------
    /**
     * CNCEngine calls this with only `if (!this.controller) return;` --
     * no try/catch. Must be crash-safe unconditionally, including before
     * bind() / after unbind().
     */
    write(data, context) {
        // RSP is a binary framed protocol; there is no raw-text passthrough
        // channel to the firmware (unlike GRBL's serial console). Rather
        // than silently dropping user input, surface it back as a console
        // line explaining why, so the UI console doesn't look broken.
        if (!this.connection) return;
        const msg = `[RSP] raw text write not supported by this protocol (ignored: ${String(data).slice(0, 64)})`;
        logger.warn(msg);
        this.emit('console', msg);
    }

    writeln(data, context) {
        this.write(data, context);
    }

    // ------------------------------------------------------------------
    // command dispatch
    // ------------------------------------------------------------------
    /**
     * Handle commands from CNCEngine/Socket.IO. Internally try/catch'd in
     * full -- some call sites in CNCEngine.js invoke controller.command()
     * without their own try/catch (e.g. socket.on('debug:enable', ...)),
     * so this method must never throw regardless of caller.
     */
    command(cmd, ...args) {
        try {
            this._dispatch(cmd, args);
        } catch (exc) {
            logger.error(`[RSP] command "${cmd}" failed: ${exc.message || exc}`);
            this.emit('error', exc);
        }
    }

    _dispatch(cmd, args) {
        if (!this.stream) {
            logger.warn(`[RSP] command "${cmd}" ignored -- controller not bound`);
            return;
        }

        switch (cmd) {
            case 'jog': {
                const p = args[0] || {};
                const feed = p.feedRate || 500;
                const axes = [
                    ['x', AXIS_X], ['y', AXIS_Y], ['z', AXIS_Z],
                ];
                const requested = axes.filter(([key]) => p[key] !== undefined && p[key] !== null && p[key] !== 0);
                if (requested.length > 1) {
                    // Diagonal jog (>1 axis nonzero): OP_JOG only moves one axis at
                    // a time, so firing it per-axis in a loop moved X to completion
                    // then Y, not together (Tawfiq msg11347 item 3). OP_MOVE takes
                    // an absolute x/y/z/feed target and the firmware coordinates
                    // all axes in one motion, same as it does for G-code moves --
                    // compute the target off the last-known telemetry position
                    // (this.state.status.mpos) and send a single frame.
                    const mpos = this.state.status.mpos || { x: 0, y: 0, z: 0 };
                    const target = {
                        x: mpos.x + (Number(p.x) || 0),
                        y: mpos.y + (Number(p.y) || 0),
                        z: mpos.z + (Number(p.z) || 0),
                    };
                    this._fireAndForget(defs.OP_MOVE, codec.buildMove(target.x, target.y, target.z, feed));
                    break;
                }
                for (const [key, axisCode] of requested) {
                    const dist = Math.abs(Number(p[key]));
                    // Direction bit convention confirmed inverted on real RSP hardware
                    // (Tawfiq msg11223: all axes moved opposite of the requested sign).
                    const direction = Number(p[key]) < 0 ? 0 : 1;
                    this._fireAndForget(defs.OP_JOG, codec.buildJog(axisCode, direction, dist, feed));
                }
                break;
            }

            case 'homing':
            case 'home':
                this._fireAndForget(defs.OP_HOME, codec.buildHome(AXIS_MASK_ALL));
                break;

            case 'unlock':
            // 'motor:reset'/'motor:resetAll'/'estop:clear'/'limit:clear' used
            // to fall through to the unknown-command default (silently
            // ignored -- confirmed by re-reading this switch end to end,
            // flagged msg11410, now hit again msg11440: Tawfiq has to
            // power-cycle the machine because the "Reset Motors"/"Clear
            // Alarm"/"Clear Limit" UI buttons sent commands this switch
            // never handled). defs.js's RSP opcode set (0x01-0x13) has
            // exactly ONE alarm-recovery primitive -- OP_UNLOCK (GRBL $X
            // equivalent) -- no separate motor-fault-clear or limit-clear
            // opcode exists. Routing all four here so the buttons actually
            // reach the firmware instead of doing nothing.
            // CAVEAT (told to Tawfiq, not silently assumed): if the motor
            // driver IC latches EV_FAULT in hardware (common for stepper
            // driver ALM outputs), OP_UNLOCK may not clear it -- that would
            // need firmware-side EN-pin toggling or a real power cycle, a
            // firmware/hardware-layer fix this file cannot make.
            case 'motor:reset':
            case 'motor:resetAll':
            case 'estop:clear':
            case 'limit:clear':
                this._fireAndForget(defs.OP_UNLOCK, Buffer.alloc(0));
                break;

            case 'reset':
                this._fireAndForget(defs.OP_SOFT_RESET, Buffer.alloc(0));
                break;

            case 'feedhold':
                this._fireAndForget(defs.OP_FEED_HOLD, Buffer.alloc(0));
                if (this.job) this.job.pause();
                break;

            case 'cyclestart':
                this._fireAndForget(defs.OP_RESUME, Buffer.alloc(0));
                if (this.job) this.job.resume();
                break;

            case 'wcs:zero': {
                const p = args[0] || {};
                let mask = 0;
                if (p.x !== undefined) mask |= AXIS_BIT_X;
                if (p.y !== undefined) mask |= AXIS_BIT_Y;
                if (p.z !== undefined) mask |= AXIS_BIT_Z;
                if (!mask) mask = AXIS_MASK_ALL;
                this._fireAndForget(defs.OP_ZERO, codec.buildZero(mask));
                break;
            }
            case 'wcs:zeroAll':
                this._fireAndForget(defs.OP_ZERO, codec.buildZero(AXIS_MASK_ALL));
                break;

            case 'gcode:load': {
                const [name, gcode] = args;
                const incoming = gcode || '';
                // Power-cut recovery: the FIRST load this controller instance
                // sees is checked against whatever resume record survived a
                // backend restart (constructor-time _loadResumeStateFromDisk).
                // If the frontend reloaded the exact same file (it does this
                // automatically on reconnect -- see App.tsx's restore effect)
                // and there's an unfinished-job record for it, treat it as
                // resumable instead of wiping to line 1. Every load AFTER
                // this first one keeps the original "fresh file = fresh
                // start" behavior, including reloading the same file a
                // second time within one session.
                if (!this._diskResumeConsumed) {
                    this._diskResumeConsumed = true;
                    const rec = this._diskResumeRecord;
                    if (rec && rec.resumeLine > 1 && rec.gcodeHash === this._gcodeHash(incoming)) {
                        this._loadedName = name || '';
                        this._loadedGcode = incoming;
                        this._resumeLine = rec.resumeLine;
                        this._resumeGcode = incoming;
                        logger.info(`[RSP] gcode:load recovered unfinished job "${this._loadedName}" -- resumable at line ${rec.resumeLine}`);
                        this.emit('console', `🔁 Recovered a job that was running before the last restart. Press START to resume from line ${rec.resumeLine}, or load a different file to start fresh.`);
                        break;
                    }
                }
                this._loadedName = name || '';
                this._loadedGcode = incoming;
                // A freshly loaded file is a new job, even if it happens to
                // have the same name/content as one that was stopped earlier
                // -- always start it at line 1, not mid-file.
                this._resumeLine = 0;
                this._resumeGcode = null;
                this._clearResumeState();
                logger.info(`[RSP] gcode:load "${this._loadedName}" (${this._loadedGcode.length} bytes)`);
                break;
            }

            case 'gcode:unload':
                if (this.job && this.job.active) this.job.abort();
                this._loadedGcode = '';
                this._loadedName = '';
                this._resumeLine = 0;
                this._resumeGcode = null;
                this._clearResumeState();
                break;

            case 'gcode:start':
                if (this._resumeGcode !== null && this._resumeGcode === this._loadedGcode && this._resumeLine > 1) {
                    logger.info(`[RSP] gcode:start resuming stopped job at line ${this._resumeLine}`);
                    this.emit('console', `▶️ Resuming from line ${this._resumeLine} (where it was stopped).`);
                    this._startJob(this._loadedGcode, this._resumeLine);
                } else {
                    this._startJob(this._loadedGcode);
                }
                break;

            case 'gcode:startFromLine': {
                const lineNumber = args[0];
                this._startJob(this._loadedGcode, typeof lineNumber === 'number' ? lineNumber : 0);
                break;
            }

            case 'gcode:pause':
                if (this.job) this.job.pause();
                this._fireAndForget(defs.OP_FEED_HOLD, Buffer.alloc(0));
                break;

            case 'gcode:resume':
                if (this.job) this.job.resume();
                this._fireAndForget(defs.OP_RESUME, Buffer.alloc(0));
                break;

            case 'gcode:stop': {
                // Capture the resume point BEFORE abort() -- nextLineToRun()
                // still reflects real progress at this instant; abort()
                // doesn't touch it, but the NEXT upload() (a fresh start)
                // would reset it to 1, so it has to be saved out here.
                const stopLine = this.job ? this.job.nextLineToRun() : 0;
                if (this.job) this.job.abort();
                if (stopLine > 1) {
                    this._resumeLine = stopLine;
                    this._resumeGcode = this._loadedGcode;
                    this._persistResumeState(stopLine);
                    this.emit('console', `⏹️ Stopped at line ${stopLine}. Press START to resume from here, or load a new file to restart.`);
                } else {
                    this._resumeLine = 0;
                    this._resumeGcode = null;
                    this._clearResumeState();
                }
                break;
            }

            case 'statusreport':
                this._requestStatus();
                break;

            case 'probe': {
                const p = args[0] || {};
                const axis = Number(p.axis);
                const dirNeg = p.dirNeg ? 1 : 0;
                const maxTravelMm = Number(p.maxTravelMm || p.distance || 25);
                const feed = Number(p.feed || p.feedRate || 100);
                this.probeAxis(axis, dirNeg, maxTravelMm, feed).catch((exc) => {
                    logger.warn(`[RSP] probe failed: ${exc.message || exc}`);
                    this.emit('probe', { success: false, error: exc.message || String(exc) });
                });
                break;
            }

            case 'feedOverride:reset':
                this._setFeedOverride(100.0);
                break;
            case 'feedOverride:coarsePlus':
                this._setFeedOverride(this._feedOverridePct + FEED_OVERRIDE_COARSE);
                break;
            case 'feedOverride:coarseMinus':
                this._setFeedOverride(this._feedOverridePct - FEED_OVERRIDE_COARSE);
                break;
            case 'feedOverride:finePlus':
                this._setFeedOverride(this._feedOverridePct + FEED_OVERRIDE_FINE);
                break;
            case 'feedOverride:fineMinus':
                this._setFeedOverride(this._feedOverridePct - FEED_OVERRIDE_FINE);
                break;

            case 'debug:enable':
                this._debugEnabled = true;
                break;
            case 'debug:disable':
                this._debugEnabled = false;
                break;

            case 'trigger:set': {
                const [eventName, config] = args;
                this._eventTriggers[eventName] = config;
                break;
            }
            case 'trigger:loadAll': {
                const [triggers] = args;
                if (triggers && typeof triggers === 'object') {
                    this._eventTriggers = { ...triggers };
                }
                break;
            }

            case 'macro:run': {
                const [content] = args;
                this._startJob(content || '');
                break;
            }

            // Not supported by the RSP opcode set (no spindle/coolant/
            // tool-change/rapid-override commands in defs.py) --
            // graceful no-op + warning, matching GenericController's
            // degrade-don't-crash philosophy rather than throwing.
            case 'rapidOverride:reset':
            case 'rapidOverride:medium':
            case 'rapidOverride:low':
            case 'spindleOverride:reset':
            case 'spindleOverride:plus':
            case 'spindleOverride:minus':
            case 'coolant:flood':
            case 'coolant:mist':
            case 'toolchange:confirm':
            case 'toolchange:cancel':
                logger.warn(`[RSP] command "${cmd}" not supported by RSP firmware -- ignored`);
                break;

            default:
                logger.warn(`[RSP] unknown command "${cmd}" -- ignored`);
                break;
        }
    }

    /** Fire a command without blocking the caller; logs and swallows LinkLost. */
    _fireAndForget(op, payload) {
        if (!this.stream) return;
        try {
            this.stream.sendCommand(op, payload, { timeout: 3.0 }).catch((exc) => {
                logger.warn(`[RSP] op 0x${op.toString(16)} failed: ${exc.message || exc}`);
            });
        } catch (exc) {
            if (!(exc instanceof LinkLost)) throw exc;
            logger.warn(`[RSP] op 0x${op.toString(16)} not sent -- link down`);
        }
    }

    _requestStatus() {
        if (!this.stream) return;
        this.stream.sendCommand(defs.OP_GET_STATUS, Buffer.alloc(0), { timeout: 2.0 })
            .then((rsp) => {
                // FT_RSP payload layout is [op, status, ...body] (2 header
                // bytes, not 1 -- FT_EVT/EV_STATUS frames are the ones with
                // just [op, ...body]). Mirrors machine.py's
                // `Telemetry(rsp.payload[2:])` exactly; confirmed via the
                // TCP-bridged simulator integration test, which surfaced a
                // "Telemetry: expected 46 bytes, got 47" error before this
                // fix -- do not regress back to subarray(1).
                if (!rsp.payload || rsp.payload.length < 2 + defs.TEL_LEN) return;
                const tel = new defs.Telemetry(rsp.payload.subarray(2));
                this._onTelemetry(tel.asDict());
            })
            .catch((exc) => {
                logger.warn(`[RSP] statusreport failed: ${exc.message || exc}`);
            });
    }

    /**
     * Native single-axis probe (RSP OP_PROBE). RSP's job-line gcode parser
     * (fw_m3/Src/easycnc_protocol.c parse_gcode_text()) has no G38.x/G10
     * support, so the GRBL-style raw-gcode probing path (ProbingService.js
     * + ProbeStrategies.js, which write() G38.2 lines and parse `[PRB:...]`
     * replies) cannot drive this firmware -- this is the RSP-native
     * replacement for a single axis touch-off.
     *
     * @param {number} axis 0=X,1=Y,2=Z
     * @param {number} dirNeg 1=negative direction, 0=positive (caller-facing
     *   semantic direction -- the wire-level bit sent below is inverted from
     *   this to match hardware, see comment at the buildProbe() call)
     * @param {number} maxTravelMm
     * @param {number} feedMmPerMin
     * @returns {Promise<{contact:boolean, axis:number, distMm:number, x:number, y:number, z:number}>}
     */
    probeAxis(axis, dirNeg, maxTravelMm, feedMmPerMin) {
        if (!this.stream) return Promise.reject(new Error('controller not bound'));
        // Direction bit: firmware's probe_axis_single() (fw_m3/Src/main.c:681)
        // writes the DIR pin for whichever axis is selected with ONE
        // uninverted line (dir_neg ? RESET : SET) -- unlike OP_MOVE's
        // motion_set_dir_pins() (main.c:382-390), which XORs Z_DIR_INVERT
        // for Z only (X and Y1 have no invert #define at all). So probe's
        // wire bit already matches move's physical convention for X/Y with
        // NO inversion needed, but is backwards for Z specifically.
        // msg11358's fix inverted ALL axes to fix Z-only-moved-up, which
        // silently broke X/Y probing from that point on -- msg11499/11514
        // (X, then X+Y, moving away from the block during actual probing)
        // is that regression. Invert ONLY for Z.
        const wireDir = (axis === 2) ? (dirNeg ? 0 : 1) : dirNeg;
        const payload = codec.buildProbe(axis, wireDir, maxTravelMm, feedMmPerMin);
        // Firmware blocks for the full probe move before replying (same
        // shape as OP_MOVE/OP_HOME) -- size the wait off the commanded
        // travel/feed instead of the ~3s default used by fire-and-forget
        // commands, plus margin for the ESTOP/FAULT debounce passes.
        const travelMinutes = maxTravelMm / Math.max(1, feedMmPerMin);
        const timeout = Math.max(10, travelMinutes * 60 * 1.5 + 5);
        return this.stream.sendCommand(defs.OP_PROBE, payload, { timeout }).then((rsp) => {
            const status = rsp.payload[1];
            if (status !== defs.ST_OK) {
                const name = defs.ST_ERR_NAMES[status] || `0x${status.toString(16)}`;
                throw new Error(`probe rejected: ${name}`);
            }
            const r = codec.parseProbeResult(rsp.payload.subarray(2));
            const out = {
                contact: r.result === defs.PROBE_RESULT_CONTACT,
                axis: r.axis,
                distMm: r.distMm,
                x: r.x, y: r.y, z: r.z,
            };
            this.emit('probe', { success: out.contact, x: out.x, y: out.y, z: out.z, axis: out.axis, distMm: out.distMm });
            return out;
        });
    }

    /**
     * Awaitable absolute move (RSP OP_MOVE), used by ProbingService's
     * RSP-native multi-axis routines to reposition BETWEEN probe touches
     * (e.g. clear Z before approaching in X) where the next probe must not
     * fire until this move has physically finished. The 'jog' dispatch
     * case fires OP_MOVE with _fireAndForget for a UI jog button, where
     * that's fine (nothing waits on it); a probing sequence needs strict
     * ordering, so this awaits the firmware's post-move reply instead,
     * same blocking-until-complete contract as probeAxis().
     *
     * The reply carries NO position payload -- confirmed against real
     * firmware source, not assumed: rsp_handle_move() in
     * fw_m3/Src/easycnc_protocol.c ends with `rsp_reply_ok(seq, op, NULL,
     * 0)` (line ~1353), and the Python FakeFirmware simulator mirrors this
     * exactly (`self._send_rsp(op, defs.ST_OK, b"", req_seq)`). An earlier
     * version of this method called the unused/unverified `codec.parseMove`
     * on the reply body expecting an x/y/z/feed echo -- that payload does
     * not exist and threw ERR_BUFFER_OUT_OF_BOUNDS the first time this was
     * driven against the real simulator. Resolve with the commanded values
     * instead; the caller already has them.
     * @returns {Promise<{x:number,y:number,z:number,feed:number}>}
     */
    _moveAbsolute(x, y, z, feed) {
        if (!this.stream) return Promise.reject(new Error('controller not bound'));
        const mpos = this.state.status.mpos || { x: 0, y: 0, z: 0 };
        const dist = Math.hypot(x - mpos.x, y - mpos.y, z - mpos.z);
        const travelMinutes = dist / Math.max(1, feed);
        const timeout = Math.max(10, travelMinutes * 60 * 1.5 + 5);
        return this.stream.sendCommand(defs.OP_MOVE, codec.buildMove(x, y, z, feed), { timeout }).then((rsp) => {
            const status = rsp.payload[1];
            if (status !== defs.ST_OK) {
                const name = defs.ST_ERR_NAMES[status] || `0x${status.toString(16)}`;
                throw new Error(`move rejected: ${name}`);
            }
            return { x, y, z, feed };
        });
    }

    _setFeedOverride(pct) {
        const clamped = Math.min(FEED_OVERRIDE_MAX, Math.max(FEED_OVERRIDE_MIN, pct));
        this._feedOverridePct = clamped;
        this._fireAndForget(defs.OP_SET_FEED_OVERRIDE, codec.buildFeedOverride(clamped));
    }

    /**
     * @param {string} gcodeText
     * @param {number} [resumeLine] if > 1, skip lines 1..resumeLine-1 (already
     *   run) and start sending from resumeLine instead of line 1.
     */
    _startJob(gcodeText, resumeLine = 0) {
        if (!this.job) return;
        if (!gcodeText || !String(gcodeText).trim()) {
            logger.warn('[RSP] gcode:start called but no G-code is loaded -- START is a no-op. Did file:load fire?');
            this.emit('console', '⚠️ START pressed but no G-code is loaded on the controller — re-upload the file.');
            return;
        }
        if (this.job.active) {
            logger.warn('[RSP] gcode:start ignored -- a job is already active');
            this.emit('console', '⚠️ START pressed but a job is already running.');
            return;
        }
        const lines = String(gcodeText || '').split(/\r?\n/);
        // Reset so the G-code panel doesn't show the previous job's last
        // highlighted line for the brief window before the first EV_EXECUTED
        // of this job arrives.
        this._currentLine = resumeLine > 1 ? resumeLine - 1 : 0;
        const jobId = this.job.upload(lines);
        // Must resume() BEFORE start() kicks the async sender loop -- see
        // JobStream.resume()'s completion-detection fix (job.js) for why
        // lines before resumeLine are marked executed, not just skipped.
        if (typeof resumeLine === 'number' && resumeLine > 1) {
            this.job.resume(resumeLine);
        }
        this.emit('sender:start', { jobId, total: lines.length, resumedFrom: resumeLine > 1 ? resumeLine : undefined });
        this.job.start();
    }

    // ------------------------------------------------------------------
    // optional interface (guarded via typeof at CNCEngine call sites)
    // ------------------------------------------------------------------
    getWorkflowState() {
        if (!this.job) return 'idle';
        if (this.job.active) return this.job.stalled ? 'stalled' : 'running';
        return 'idle';
    }

    getSenderStatus() {
        if (!this.job) return null;
        const [executed, total] = this.job.progress;
        return {
            active: this.job.active,
            jobId: this.job.jobId,
            executed,
            total,
            sent: executed,
            // Same field names as _bindJobListeners()'s live 'progress'
            // emit -- this is the initial-sync value sent on socket connect
            // (CNCEngine.js socket.emit('sender:status', ...)), so it must
            // match or the current-line highlight starts wrong on page load
            // until the next executed line arrives.
            received: this._currentLine || 0,
            progress: total > 0 ? Math.round((executed / total) * 100) : 0,
            stalled: this.job.stalled,
            failReason: this.job.failReason,
            feedOverridePct: this._feedOverridePct,
        };
    }

    getHealthMetrics() {
        return {
            linkOk: this.stream ? this.stream.linkOk : false,
            inFlight: this.stream ? this.stream.inFlight : 0,
            lastPongAt: this._lastPongAt,
        };
    }

    getEventTriggers() {
        return { ...this._eventTriggers };
    }

    getState() {
        return {
            type: this.type,
            status: this.state.status,
            parserstate: this.state.parserstate,
            linkOk: this.stream ? this.stream.linkOk : false,
            job: this.getSenderStatus(),
        };
    }
}

module.exports = { RSPController, ConnectionTransport };
