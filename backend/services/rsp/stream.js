/**
 * ReliableStream: host-side reliability engine for RSP over USB-CDC.
 *
 * Faithful port of the Python reference (backend/rsp/stream.py from
 * fw_m3_control_sw) -- SAME guarantees, SAME wire contract, SAME bug-fix
 * comments preserved verbatim below because they document real incidents
 * (stall-vs-heartbeat link-down, SEQ_GAP livelock, rx-error-storm, stale-
 * session catch-up). Only the concurrency model differs: Python used a
 * background thread polling transport.recv()/blocking condvars; Node is
 * single-threaded and event-driven, so:
 *   - inbound bytes arrive via the transport's 'data' event (pushed in,
 *     not polled) and are fed straight into the FrameParser
 *   - the periodic retransmit/stall/heartbeat sweep runs on a
 *     setInterval(TICK_MS) tick instead of a thread loop
 *   - sendCommand() returns a Promise (resolved on FT_RSP, rejected on
 *     timeout/LinkLost) instead of blocking on a threading.Condition
 *   - no locks are needed (no other thread can interleave)
 *
 * Guarantees:
 *   - no data loss        -> windowed transmission + retransmission on RTO
 *   - no corruption       -> CRC32 validated by the device; corrupted -> NAK -> resend
 *   - no duplication      -> every (re)send keeps its seq; duplicate ACKs ignored
 *   - strict ordering     -> seq enforced; a SEQ_GAP makes the host resend from the gap
 *   - flow control        -> device NAKs with ST_ERR_BUFFER when its planner is full;
 *                            the engine backs off and retries; telemetry exposes
 *                            buffer_fill_pct / planner_depth for the UI
 *
 * Wire contract (device side implements the mirror):
 *   - Every CMD carries F_ACK and a seq. Device replies ACK(seq) once the
 *     command is accepted (validated + buffered), or NAK(seq, reason).
 *   - Device executes buffered job lines strictly in seq order; each
 *     completed line emits EV_EXECUTED(job_id, line_no, x, y, z).
 *   - If the device has not been heard from for >3*heartbeat, the link is
 *     declared dead (LinkLost) -- callers decide recovery.
 *   - If a single command has been outstanding (unresolved by ACK/RSP) for
 *     longer than `stallTimeoutS`, the link is declared dead even if the
 *     device keeps validly NAK-ing it with ST_ERR_BUFFER. A device that is
 *     genuinely, permanently stuck (planner never drains) still replies
 *     with well-formed NAKs forever -- that resets the per-command retry
 *     counter on every NAK (see _handleNak), so pure retry-count
 *     exhaustion never fires and the heartbeat-liveness check never fires
 *     either (NAKs count as valid rx traffic). Without this, a stuck
 *     device produces an infinite, silent resend loop with no error ever
 *     surfaced to the caller.
 */
'use strict';

const EventEmitter = require('events');
const defs = require('./defs');
const {
    FT_ACK, FT_CMD, FT_EVT, FT_HB, FT_NAK, FT_RSP,
    F_ACK, FrameParser, buildFrame,
} = require('./frame');

// Transport-level window (frames in flight). Job streaming additionally
// honors execution credits (JobStream.depth) so we never overrun the
// device planner -- ACK means "accepted", not "slot freed".
const DEFAULT_WINDOW = 16;
const DEFAULT_RTO_S = 0.10;
const MAX_RETRIES = 8;
const DEFAULT_HEARTBEAT_S = 1.0;
// Absolute cap on how long any single command may sit unresolved, regardless
// of how many times its retry counter gets reset by a valid BUFFER NAK.
const DEFAULT_STALL_TIMEOUT_S = 20.0;

// Tick interval for the retransmit/stall/heartbeat sweep. Python polled
// transport.recv(0.005) i.e. a 5ms cadence; mirrored here.
const TICK_MS = 5;

function now() {
    return Date.now() / 1000;
}

class LinkLost extends Error {}
class RspTimeoutError extends Error {}

class Pending {
    constructor(seq, payload, sentAt, rto, durable, firstSentAt) {
        this.seq = seq;
        this.payload = payload; // Buffer, full frame payload including opcode byte
        this.sentAt = sentAt;
        this.retries = 0;
        this.rto = rto;
        this.durable = durable;
        this.bufferBackoffUntil = 0.0; // flow-control pause (BUFFER NAK)
        this.firstSentAt = firstSentAt; // set once at creation; NEVER reset by NAK handling
    }
}

/**
 * Minimal logger interface, defaults to console with level-aware calls.
 * Callers may pass their own `{debug,info,warn,error}` compatible logger
 * (e.g. winston) via options.logger.
 */
function defaultLogger() {
    return {
        debug: () => {},
        info: (...a) => console.log('[rsp.stream]', ...a),
        warn: (...a) => console.warn('[rsp.stream]', ...a),
        error: (...a) => console.error('[rsp.stream]', ...a),
    };
}

/**
 * transport contract expected by ReliableStream:
 *   transport.send(buffer)        -- may throw synchronously on tx failure
 *   transport.on('data', cb)      -- cb(Buffer) for each inbound chunk
 *   transport.on('error', cb)     -- cb(Error) on transport-level rx failure
 *   transport.close()             -- optional
 *   transport.reconnect()         -- optional
 */
class ReliableStream extends EventEmitter {
    constructor(transport, options = {}) {
        super();
        this.transport = transport;
        this.window = options.window ?? DEFAULT_WINDOW;
        this.rtoS = options.rtoS ?? DEFAULT_RTO_S;
        this.heartbeatS = options.heartbeatS ?? DEFAULT_HEARTBEAT_S;
        this.maxRetries = options.maxRetries ?? MAX_RETRIES;
        this.stallTimeoutS = options.stallTimeoutS ?? DEFAULT_STALL_TIMEOUT_S;
        // Optional callback-style hooks (parity with the Python ctor args);
        // events 'event' / 'status' / 'link' are also emitted regardless.
        this.onEvent = options.onEvent || null;
        this.onStatus = options.onStatus || null;
        this.onLinkChange = options.onLinkChange || null;
        this._log = options.logger || defaultLogger();

        this._parser = new FrameParser();
        this._txSeq = 0;
        this._sent = new Map(); // seq -> Pending
        this._devAckSeq = -1; // device has ACKed every seq <= this

        this._linkOk = false;
        this._lastRx = 0.0;
        this._lastHb = 0.0;
        // While true (during an active job), the background heartbeat is
        // suppressed -- interleaving FT_HB frames with pipelined job lines
        // slows/stalls the firmware's move execution (see JobStream.upload()/
        // _finishJob()/abort()). Ported from stream.py's _heartbeat_paused;
        // missing here meant every JS-side job ran with heartbeats still
        // firing every heartbeatS the whole time. Only the periodic
        // keepalive send is gated -- the idle link-liveness check below
        // still needs live heartbeats when nothing else is happening, so
        // the timeout side is deliberately left ungated (matches Python).
        this._heartbeatPaused = false;
        // rx-error-storm handling: a dead OS-level handle makes every rx
        // fail identically, forever, with no backoff -- these track that
        // streak so we can throttle the log, back off, and periodically
        // try to reopen the transport.
        this._rxErrorStreak = 0;
        this._lastRxErrorLog = 0.0;
        this._lastReconnectAttempt = 0.0;
        // "stall" link-loss (retries/absolute-timeout exhausted while the
        // device is STILL validly NAK-ing/emitting telemetry) must NOT be
        // auto-revived by generic rx like the heartbeat-silence case is --
        // that NAK/telemetry traffic is exactly what masked the original
        // DESIGN_CARVE_ERROR.txt bug (see _checkStalled). Only a real ACK/
        // RSP proves the device can actually complete a durable command
        // again; see _handle()'s FT_ACK/FT_RSP branches below.
        this._linkDownReason = '';
        this._lastGapNak = 0.0;

        // blocking reply waiters -> Promise resolvers
        this._replyWaiters = new Map(); // seq -> {resolve, reject, timer}

        this._tickTimer = null;
        this._onData = this._onData.bind(this);
        this._onTransportError = this._onTransportError.bind(this);
    }

    // ------------------------------------------------------------------
    // state
    // ------------------------------------------------------------------
    get linkOk() {
        return this._linkOk;
    }

    get inFlight() {
        return this._sent.size;
    }

    get available() {
        return Math.max(0, this.window - this.inFlight);
    }

    /** Suppress/resume the background heartbeat. Pause during an active job. */
    setHeartbeatPaused(paused) {
        this._heartbeatPaused = !!paused;
    }

    _setLink(ok, reason = '') {
        if (ok) {
            this._linkDownReason = '';
        } else if (!this._linkOk) {
            // already down, don't clobber an existing reason
        } else {
            this._linkDownReason = reason;
        }
        if (ok !== this._linkOk) {
            this._linkOk = ok;
            if (this.onLinkChange) this.onLinkChange(ok);
            this.emit('link', ok);
        }
    }

    // -------------------------------------------------------------------------
    // transmit API
    // -------------------------------------------------------------------------
    /**
     * Send a command and resolve once its RSP reply arrives.
     * @returns {Promise<import('./frame').ParsedFrame>}
     */
    sendCommand(op, payload, { durable = true, timeout = 3.0 } = {}) {
        if (!this._linkOk) {
            return Promise.reject(new LinkLost('link not up'));
        }
        const seq = this._takeSeq();
        const body = Buffer.concat([Buffer.from([op & 0xFF]), payload || Buffer.alloc(0)]);
        const now0 = now();
        this._sent.set(seq, new Pending(seq, body, now0, this.rtoS, durable, now0));

        return new Promise((resolve, reject) => {
            // NOTE: intentionally NOT unref()'d -- this timer is the only
            // mechanism that guarantees the returned Promise ever settles.
            // Unref'ing it (as the tick interval below does) let Node exit
            // the process before an unanswered command's timeout fired in
            // testing, leaving the caller's await hanging forever with no
            // error surfaced. Found via stream_smoke.js test 5.
            const timer = setTimeout(() => {
                this._replyWaiters.delete(seq);
                reject(new RspTimeoutError(`no reply for seq ${seq}`));
            }, Math.max(0, timeout) * 1000);
            this._replyWaiters.set(seq, { resolve, reject, timer });

            try {
                this.transport.send(buildFrame(FT_CMD, F_ACK, seq, body));
            } catch (exc) {
                // Same class of transient stall _retransmitReady() already
                // tolerates for queued resends. Killing the whole job on the
                // FIRST such blip -- while the identical failure on a
                // background resend is treated as recoverable -- was the
                // bug: leave the packet queued so the retry loop naturally
                // resends it.
                this._log.warn(`tx error sending seq ${seq}: ${exc.message || exc}`);
                this._setLink(false, 'tx_error');
            }
        });
    }

    /**
     * Queue a command without blocking; returns its seq, or -1 if the
     * window is full (caller should back off / wait for ACKs).
     */
    sendNowait(op, payload, durable = true) {
        if (!this._linkOk) {
            throw new LinkLost('link not up');
        }
        if (this.available <= 0) {
            return -1;
        }
        const seq = this._takeSeq();
        const body = Buffer.concat([Buffer.from([op & 0xFF]), payload || Buffer.alloc(0)]);
        const now0 = now();
        this._sent.set(seq, new Pending(seq, body, now0, this.rtoS, durable, now0));
        try {
            this.transport.send(buildFrame(FT_CMD, F_ACK, seq, body));
        } catch (exc) {
            // See sendCommand()'s matching comment: a transient tx stall
            // must not kill the job here either -- leave it queued for
            // _retransmitReady() to pick up like any other pending seq.
            this._log.warn(`tx error sending seq ${seq}: ${exc.message || exc}`);
            this._setLink(false, 'tx_error');
        }
        return seq;
    }

    // -------------------------------------------------------------------------
    // lifecycle
    // -------------------------------------------------------------------------
    start() {
        if (this._tickTimer) return; // already started
        this._setLink(true);
        this._lastRx = now();
        this._lastHb = now();
        if (typeof this.transport.on === 'function') {
            this.transport.on('data', this._onData);
            this.transport.on('error', this._onTransportError);
        }
        this._tickTimer = setInterval(() => this._tick(), TICK_MS);
        if (typeof this._tickTimer.unref === 'function') this._tickTimer.unref();
    }

    stop() {
        if (this._tickTimer) {
            clearInterval(this._tickTimer);
            this._tickTimer = null;
        }
        if (typeof this.transport.removeListener === 'function') {
            this.transport.removeListener('data', this._onData);
            this.transport.removeListener('error', this._onTransportError);
        }
        // reject any still-outstanding sendCommand() waiters so callers
        // don't hang forever after an explicit stop()
        for (const [seq, waiter] of this._replyWaiters) {
            clearTimeout(waiter.timer);
            waiter.reject(new LinkLost('stream stopped'));
        }
        this._replyWaiters.clear();
    }

    close() {
        this.stop();
        if (typeof this.transport.close === 'function') {
            this.transport.close();
        }
    }

    // ------------------------------------------------------------------
    // internal
    // ------------------------------------------------------------------
    _takeSeq() {
        const s = this._txSeq;
        this._txSeq = (this._txSeq + 1) & 0xFFFF;
        return s;
    }

    _onData(data) {
        const n = now();
        this._rxErrorStreak = 0;
        if (data && data.length) {
            this._lastRx = n;
            // Silence-based link-down (heartbeat timeout / tx error)
            // genuinely means "we don't know if the device is even there"
            // -- any rx is real proof of life, revive now. Stall-based
            // link-down means the device IS talking (NAKs, telemetry) but
            // a durable command never actually completes -- that traffic
            // must NOT count as recovery, or we're back to the exact bug
            // this fixes. Only an ACK/RSP proves it, handled in _handle().
            if (!this._linkOk && this._linkDownReason !== 'stall') {
                this._log.info('rx while link down -- link restored');
                this._setLink(true);
            }
            let frames;
            try {
                frames = this._parser.feed(data);
            } catch (exc) {
                this._log.warn(`frame parse error: ${exc.message || exc}`);
                return;
            }
            for (const f of frames) {
                this._handle(f, n);
            }
        }
    }

    _onTransportError(exc) {
        // A dead OS-level handle (e.g. Windows ClearCommError/
        // PermissionError after the USB-CDC device drops off the bus)
        // makes every recv() fail identically and instantly -- confirmed
        // live 2026-08-27 (Tawfiq's job 31739): 9957 identical "rx error"
        // lines in ~2.5 minutes, link never recovering, because nothing
        // throttled the log, backed off the poll rate, or ever reopened
        // the handle. Fix: throttle the log to once per streak-start +
        // once per 2s, and periodically try to reopen the transport.
        const n = now();
        this._rxErrorStreak += 1;
        if (this._rxErrorStreak === 1 || (n - this._lastRxErrorLog) >= 2.0) {
            this._log.warn(`rx error: ${exc.message || exc} (streak=${this._rxErrorStreak})`);
            this._lastRxErrorLog = n;
        }
        this._setLink(false, 'tx_error');
        if (
            this._rxErrorStreak % 10 === 0 &&
            (n - this._lastReconnectAttempt) >= 2.0 &&
            typeof this.transport.reconnect === 'function'
        ) {
            this._lastReconnectAttempt = n;
            try {
                this.transport.reconnect();
                this._log.info(`reconnect attempt after ${this._rxErrorStreak} consecutive rx errors`);
            } catch (reconnectExc) {
                this._log.warn(`reconnect failed: ${reconnectExc.message || reconnectExc}`);
            }
        }
    }

    _tick() {
        const n = now();

        // retransmit due
        this._retransmitReady(n);

        // absolute stall check -- catches a device that keeps validly
        // NAK-ing (ST_ERR_BUFFER) forever, which otherwise resets retry
        // counters indefinitely and never trips LinkLost
        this._checkStalled(n);

        // heartbeat liveness
        const n2 = now();
        if (this._linkOk && (n2 - this._lastRx) > this.heartbeatS * 3.0) {
            this._log.warn('heartbeat timeout -- link lost');
            this._setLink(false, 'heartbeat');
            this._lastRx = n2;
        }

        if (!this._heartbeatPaused && this._linkOk && (n2 - this._lastHb) >= this.heartbeatS) {
            this._lastHb = n2;
            try {
                this.transport.send(buildFrame(FT_HB, 0, 0, Buffer.alloc(0)));
            } catch (exc) {
                this._setLink(false, 'tx_error');
            }
        }
    }

    _retransmitReady(n) {
        const toResend = [];
        for (const [seq, p] of this._sent) {
            if (n - p.sentAt >= p.rto) {
                toResend.push(seq);
            }
        }
        for (const seq of toResend) {
            const p = this._sent.get(seq);
            if (!p) continue;
            p.retries += 1;
            if (p.retries > this.maxRetries) {
                this._log.warn(`seq ${seq} retries exhausted`);
                if (p.durable) {
                    this._setLink(false, 'stall');
                }
                this._sent.delete(seq);
                continue;
            }
            p.sentAt = n;
            p.rto = Math.min(p.rto * 2.0, 5.0);
            try {
                this.transport.send(buildFrame(FT_CMD, F_ACK, seq, p.payload));
            } catch (exc) {
                // Same class of fault as the rx-side handler above and the
                // heartbeat send below: a dead transport must not be
                // allowed to throw out of the tick -- an uncaught
                // exception here would kill the interval permanently,
                // silently, with no LinkLost ever surfacing to callers.
                this._log.warn(`tx error resending seq ${seq}: ${exc.message || exc}`);
                this._setLink(false, 'tx_error');
                continue;
            }
            this._log.info(`resend seq ${seq} (retry ${p.retries})`);
        }
    }

    _checkStalled(n) {
        const stalled = [];
        for (const [seq, p] of this._sent) {
            if (n - p.firstSentAt >= this.stallTimeoutS) {
                stalled.push(seq);
            }
        }
        if (stalled.length === 0) return;
        let anyDurable = false;
        for (const seq of stalled) {
            const p = this._sent.get(seq);
            this._sent.delete(seq);
            if (!p) continue;
            this._log.warn(
                `seq ${seq} stalled -- unresolved for ${(n - p.firstSentAt).toFixed(1)}s despite ` +
                `${p.retries} retries (device likely stuck, not momentarily busy)`
            );
            if (p.durable) anyDurable = true;
        }
        if (anyDurable) {
            this._setLink(false, 'stall');
        }
    }

    // ------------------------------------------------------------------
    // inbound
    // ------------------------------------------------------------------
    _handle(f, n) {
        this._lastRx = n;
        if (f.frameType === FT_ACK) {
            const hadPending = this._sent.has(f.seq);
            this._sent.delete(f.seq);
            if (f.seq > this._devAckSeq) {
                this._devAckSeq = f.seq;
            }
            // A stall-downed link only recovers once a durable command
            // this side is actually waiting on gets a real ACK -- proof
            // the device can complete work again, not just that it's
            // still chattering NAKs/telemetry (see _onData's rx-revival
            // guard).
            if (hadPending && !this._linkOk && this._linkDownReason === 'stall') {
                this._log.info(`ACK for pending seq ${f.seq} -- link restored`);
                this._setLink(true);
            }
        } else if (f.frameType === FT_NAK) {
            this._handleNak(f);
        } else if (f.frameType === FT_RSP) {
            const hadPending = this._sent.has(f.seq);
            const waiter = this._replyWaiters.get(f.seq);
            if (waiter) {
                clearTimeout(waiter.timer);
                this._replyWaiters.delete(f.seq);
                waiter.resolve(f);
            }
            // also drop from pending (acknowledged by the reply itself)
            this._sent.delete(f.seq);
            if (hadPending && !this._linkOk && this._linkDownReason === 'stall') {
                this._log.info(`RSP for pending seq ${f.seq} -- link restored`);
                this._setLink(true);
            }
        } else if (f.frameType === FT_EVT) {
            if (f.payload && f.payload.length) {
                const op = f.payload[0];
                if (op === defs.EV_STATUS) {
                    try {
                        const t = new defs.Telemetry(f.payload.subarray(1));
                        const dict = t.asDict();
                        if (this.onStatus) this.onStatus(dict);
                        this.emit('status', dict);
                    } catch (exc) {
                        this._log.warn(`bad telemetry: ${exc.message || exc}`);
                    }
                }
                if (this.onEvent) this.onEvent(f);
                this.emit('event', f);
            }
        }
        // FT_HB: nothing to do
    }

    _handleNak(f) {
        if (!f.payload || f.payload.length < 2) return;
        const op = f.payload[0];
        const reason = f.payload[1];
        const opName = defs.OP_NAMES[op] || `OP_0x${op.toString(16).padStart(2, '0')}`;
        const reasonName = defs.ST_ERR_NAMES[reason] || `0x${reason.toString(16).padStart(2, '0')}`;
        // BUFFER/SEQ_GAP are expected flow-control chatter (device planner
        // full, or resync after reconnect) -- log at debug so they don't
        // drown out real faults; anything else is a genuine rejection.
        if (reason === defs.ST_ERR_BUFFER || reason === defs.ST_ERR_SEQ_GAP) {
            this._log.debug(`NAK seq=${f.seq} op=${opName} reason=${reasonName}`);
        } else {
            this._log.warn(`NAK seq=${f.seq} op=${opName} reason=${reasonName}`);
        }
        const n = now();
        if (reason === defs.ST_ERR_BUFFER) {
            // flow control -- the device said "slow down", not "give up":
            // reset retry accounting and re-send after a fixed backoff
            const p = this._sent.get(f.seq);
            if (p) {
                p.retries = 0;
                p.rto = Math.max(this.rtoS, 0.5);
                p.sentAt = n;
                p.bufferBackoffUntil = n + 0.45;
            }
        } else if (reason === defs.ST_ERR_SEQ_GAP) {
            // device wants us to resend from `f.seq` (the first seq it
            // needs). Throttle + normal-RTO pacing so we never NAK-flood
            // the link.
            if (n - this._lastGapNak < 0.05) return;
            this._lastGapNak = n;
            const gap = f.seq;
            let resend = null;
            for (const s of Array.from(this._sent.keys())) {
                if (s < gap) this._sent.delete(s);
            }
            this._devAckSeq = gap - 1;
            for (const [s, p] of this._sent) {
                // leave head-of-line frames under BUFFER backoff alone --
                // resetting their timer would starve them forever
                if (s >= gap && n >= (p.bufferBackoffUntil || 0.0)) {
                    p.retries = 0;
                    p.rto = this.rtoS;
                    p.sentAt = n;
                    if (s === gap) {
                        resend = [s, p.payload];
                    }
                }
            }
            // Stale-session case: a device that kept its expected-seq
            // counter across a reconnect can ask for a gap the host never
            // even sent yet (e.g. device wants seq 7, fresh host is still
            // on seq 0). Without this, _txSeq never catches up -- every
            // NEW command keeps going out at the host's old low seq and
            // gets NAKed with the same gap forever (the "first command
            // rejected forever" symptom in CARVE_ERROR_FINDINGS.md bug 2).
            // Only ever move forward.
            if (gap > this._txSeq) {
                this._txSeq = gap;
            }
            // Resetting sentAt above only re-arms _retransmitReady()'s RTO
            // timer for later -- it does NOT itself put a frame on the
            // wire. If SEQ_GAP NAKs keep arriving faster than that RTO
            // (which they will: every other in-window frame the device
            // rejects as out-of-order re-triggers one), the reset keeps
            // re-arming before the timer ever elapses and the
            // head-of-line frame is silently never retransmitted again --
            // a livelock, not a timeout, so neither the retry-exhaustion
            // nor the stall-timeout safety net ever fires. Actually resend
            // it here, on the spot, using the exact seq the device told
            // us it's waiting for.
            if (resend !== null) {
                const [seq, payload] = resend;
                try {
                    this.transport.send(buildFrame(FT_CMD, F_ACK, seq, payload));
                } catch (exc) {
                    this._log.warn(`tx error resending seq ${seq} after SEQ_GAP: ${exc.message || exc}`);
                    this._setLink(false, 'tx_error');
                }
            }
        } else {
            this._sent.delete(f.seq);
        }
    }
}

module.exports = {
    DEFAULT_WINDOW, DEFAULT_RTO_S, MAX_RETRIES, DEFAULT_HEARTBEAT_S,
    DEFAULT_STALL_TIMEOUT_S,
    LinkLost, RspTimeoutError,
    Pending,
    ReliableStream,
};
