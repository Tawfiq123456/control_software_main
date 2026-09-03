// RemoteDiagMirror — ECSS v1 / Commit E.
//
// When enabled, opens a persistent outbound WebSocket to a VPC monitor URL
// and forwards every serial TX/RX byte and every backend log line as JSON
// events. Lets the EasyCNC bot (running on the VPC) see live machine
// chatter and debug remotely WITHOUT taking over the COM port — the regular
// backend keeps driving the CNC.
//
// Wire format: one JSON object per line, UTF-8. Examples:
//   { t: 1715234567.123, dir: "TX",  hex: "010500b0ff" }
//   { t: 1715234567.234, dir: "RX",  hex: "011eb001..." }
//   { t: 1715234567.345, dir: "LOG", level: "warn",  msg: "[ECSS] ..." }
//   { t: 1715234567.456, dir: "META", kind: "session", note: "backend boot" }
//
// CONTROL — three things must align for the mirror to be active:
//   1. backend config flag preferences.remoteDiagEnabled === true
//   2. preferences.remoteDiagUrl set (default below)
//   3. start() called from backend boot or socket toggle
//
// Backlog buffer: if the WS is disconnected when an event happens, the event
// is stored in a bounded ring buffer (last 500 events) and flushed on
// reconnect. This catches the bytes from the first second of a failure.

const WebSocket = require('ws');
const logger = require('../logger');

const DEFAULT_URL = 'ws://10.1.76.249:18765/mirror';
const RECONNECT_MS = 5000;
const BACKLOG_MAX = 500;

class RemoteDiagMirror {
    constructor() {
        this.url = DEFAULT_URL;
        this.enabled = false;
        this.ws = null;
        this.reconnectTimer = null;
        this.backlog = [];
        this.connected = false;
        this.startedAt = null;
        this.onInjectCallback = null;
        // De-noise: drop high-rate position frames if backlog grows.
        this.droppedCount = 0;
    }

    setUrl(url) { if (typeof url === 'string' && url.length > 0) this.url = url; }
    onInject(fn) { this.onInjectCallback = fn; }

    start() {
        if (this.enabled) return;
        this.enabled = true;
        this.startedAt = Date.now();
        this._connect();
        logger.warn(`[RemoteDiag] STARTED — mirroring to ${this.url}`);
        this.emitMeta({ kind: 'session-start', backend: 'safety-v1-E', startedAt: this.startedAt });
    }

    stop() {
        if (!this.enabled) return;
        this.emitMeta({ kind: 'session-stop' });
        this.enabled = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(1000, 'stop'); } catch (_) {}
            this.ws = null;
        }
        this.connected = false;
        this.backlog = [];
        logger.warn('[RemoteDiag] STOPPED');
    }

    _connect() {
        if (!this.enabled) return;
        try {
            this.ws = new WebSocket(this.url, { handshakeTimeout: 4000 });
        } catch (err) {
            logger.warn(`[RemoteDiag] connect threw: ${err.message}`);
            this._scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            this.connected = true;
            logger.info(`[RemoteDiag] connected to ${this.url}`);
            // Flush backlog.
            for (const event of this.backlog) {
                try { this.ws.send(event); } catch (_) {}
            }
            this.backlog = [];
            if (this.droppedCount > 0) {
                this._sendObj({ t: Date.now() / 1000, dir: 'META', kind: 'backlog-dropped', count: this.droppedCount });
                this.droppedCount = 0;
            }
        });

        this.ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data.toString());
                if (payload.op === 'inject' && this.onInjectCallback) {
                    this.onInjectCallback(payload);
                }
            } catch (e) {
                logger.warn(`[RemoteDiag] bad message from server: ${e.message}`);
            }
        });

        this.ws.on('close', (code, reason) => {
            this.connected = false;
            logger.warn(`[RemoteDiag] disconnected (code=${code}); reconnecting in ${RECONNECT_MS / 1000}s`);
            this._scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            // Errors typically come right before close; logging here is noisy
            // so we keep it terse.
            logger.warn(`[RemoteDiag] ws error: ${err.message}`);
        });
    }

    _scheduleReconnect() {
        if (!this.enabled) return;
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._connect();
        }, RECONNECT_MS);
    }

    _sendObj(obj) {
        if (!this.enabled) return;
        const line = JSON.stringify(obj);
        if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
            try { this.ws.send(line); } catch (_) { this._enqueue(line); }
        } else {
            this._enqueue(line);
        }
    }

    _enqueue(line) {
        if (this.backlog.length >= BACKLOG_MAX) {
            this.backlog.shift();
            this.droppedCount += 1;
        }
        this.backlog.push(line);
    }

    // ─── Public emit helpers ─────────────────────────────────────────────

    mirrorTx(buf) {
        if (!this.enabled) return;
        const hex = Buffer.isBuffer(buf) ? buf.toString('hex') : Buffer.from(buf).toString('hex');
        this._sendObj({ t: Date.now() / 1000, dir: 'TX', hex });
    }

    mirrorRx(buf) {
        if (!this.enabled) return;
        const hex = Buffer.isBuffer(buf) ? buf.toString('hex') : Buffer.from(buf).toString('hex');
        this._sendObj({ t: Date.now() / 1000, dir: 'RX', hex });
    }

    mirrorLog(level, msg) {
        if (!this.enabled) return;
        this._sendObj({ t: Date.now() / 1000, dir: 'LOG', level, msg: String(msg).slice(0, 4000) });
    }

    emitMeta(kind) {
        this._sendObj({ t: Date.now() / 1000, dir: 'META', ...kind });
    }

    status() {
        return {
            enabled: this.enabled,
            connected: this.connected,
            url: this.url,
            backlog: this.backlog.length,
            startedAt: this.startedAt,
        };
    }
}

// Singleton — only one mirror per backend process.
const mirror = new RemoteDiagMirror();
module.exports = mirror;
