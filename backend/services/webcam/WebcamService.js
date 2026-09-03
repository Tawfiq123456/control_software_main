/**
 * WebcamService — remote shop-floor monitoring.
 *
 * Cameras (configurable in Settings):
 *   - type: 'mjpeg-url'   — proxy an upstream MJPEG stream (IP cam)
 *   - type: 'rtsp'        — spawn ffmpeg to transcode RTSP → MJPEG
 *   - type: 'v4l2'        — spawn ffmpeg on a /dev/video* USB device
 *
 * HTTP routes mounted by index.js:
 *   GET /api/webcam/cameras          → list configured cameras
 *   POST /api/webcam/cameras         → upsert a camera
 *   DELETE /api/webcam/cameras/:id   → remove
 *   GET /api/webcam/stream/:id       → MJPEG live stream (multipart/x-mixed-replace)
 *   GET /api/webcam/snapshot/:id     → single JPEG
 *
 * Emits via Socket.IO:
 *   webcam:cameras  (list, on change)
 *   webcam:status   ({id, online, error})
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class Camera extends EventEmitter {
    constructor(cfg) {
        super();
        this.cfg = cfg;
        this.subscribers = new Set();   // res objects for MJPEG stream
        this.lastFrame = null;
        this.lastError = null;
        this.proc = null;               // ffmpeg child, if used
        this.upstream = null;           // http.IncomingMessage if proxying
        this.online = false;
    }

    start() {
        if (this.cfg.type === 'mjpeg-url') return this._startProxy();
        if (this.cfg.type === 'rtsp' || this.cfg.type === 'v4l2') return this._startFfmpeg();
        throw new Error(`Unknown camera type: ${this.cfg.type}`);
    }

    stop() {
        try { if (this.proc) this.proc.kill('SIGTERM'); } catch (_) {}
        try { if (this.upstream) this.upstream.destroy(); } catch (_) {}
        for (const res of this.subscribers) { try { res.end(); } catch (_) {} }
        this.subscribers.clear();
        this.online = false;
        this.proc = null;
        this.upstream = null;
    }

    subscribe(res) {
        const boundary = 'easycnc-frame';
        res.writeHead(200, {
            'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Connection': 'close',
        });
        this.subscribers.add(res);
        res.on('close', () => this.subscribers.delete(res));
        if (this.lastFrame) this._sendFrame(res, this.lastFrame);
    }

    snapshot() {
        return this.lastFrame;
    }

    _broadcast(buf) {
        this.lastFrame = buf;
        for (const res of this.subscribers) this._sendFrame(res, buf);
    }

    _sendFrame(res, buf) {
        try {
            res.write(`--easycnc-frame\r\n`);
            res.write(`Content-Type: image/jpeg\r\n`);
            res.write(`Content-Length: ${buf.length}\r\n\r\n`);
            res.write(buf);
            res.write(`\r\n`);
        } catch (e) {
            this.subscribers.delete(res);
        }
    }

    _startProxy() {
        const u = new URL(this.cfg.url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get(this.cfg.url, (incoming) => {
            this.upstream = incoming;
            this.online = true;
            this.lastError = null;
            this.emit('status', { online: true });

            // Parse MJPEG: boundary-delimited JPEG frames.
            const ct = incoming.headers['content-type'] || '';
            const m = ct.match(/boundary=(?:"?)([^";]+)/i);
            const boundary = m ? Buffer.from('--' + m[1]) : null;
            if (!boundary) {
                // Some cameras just stream raw JPEG concatenated; fall back to SOI/EOI scan.
                this._scanJpegStream(incoming);
                return;
            }
            this._scanMjpegStream(incoming, boundary);
        });
        req.on('error', (err) => {
            this.online = false;
            this.lastError = err.message;
            this.emit('status', { online: false, error: err.message });
        });
    }

    _scanMjpegStream(stream, boundary) {
        let buf = Buffer.alloc(0);
        stream.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            let idx;
            while ((idx = buf.indexOf(boundary)) !== -1) {
                if (idx > 0) {
                    // Frame before boundary: strip headers, find JPEG.
                    const part = buf.slice(0, idx);
                    const soi = part.indexOf(Buffer.from([0xff, 0xd8]));
                    if (soi !== -1) {
                        const jpeg = part.slice(soi);
                        this._broadcast(jpeg);
                    }
                }
                buf = buf.slice(idx + boundary.length);
            }
            if (buf.length > 5 * 1024 * 1024) buf = Buffer.alloc(0); // bail-out guard
        });
        stream.on('end', () => { this.online = false; });
    }

    _scanJpegStream(stream) {
        let buf = Buffer.alloc(0);
        stream.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            while (true) {
                const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
                if (soi < 0) break;
                const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
                if (eoi < 0) break;
                this._broadcast(buf.slice(soi, eoi + 2));
                buf = buf.slice(eoi + 2);
            }
            if (buf.length > 5 * 1024 * 1024) buf = Buffer.alloc(0);
        });
    }

    _startFfmpeg() {
        const args = this.cfg.type === 'rtsp'
            ? ['-rtsp_transport', 'tcp', '-i', this.cfg.url]
            : ['-f', 'v4l2', '-framerate', String(this.cfg.fps || 15),
               '-video_size', this.cfg.resolution || '640x480',
               '-i', this.cfg.device || '/dev/video0'];
        const ffArgs = [
            ...args,
            '-q:v', String(this.cfg.quality || 5),
            '-r', String(this.cfg.fps || 15),
            '-vf', `scale=${(this.cfg.resolution || '640x480').replace('x', ':')}`,
            '-f', 'mjpeg',
            '-an',
            'pipe:1',
        ];
        try {
            this.proc = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            this.lastError = 'ffmpeg not installed: ' + e.message;
            this.emit('status', { online: false, error: this.lastError });
            return;
        }
        this.online = true;
        this.emit('status', { online: true });
        this._scanJpegStream(this.proc.stdout);
        this.proc.on('exit', (code) => {
            this.online = false;
            if (code !== 0) {
                this.lastError = `ffmpeg exited ${code}`;
                this.emit('status', { online: false, error: this.lastError });
            }
        });
        this.proc.stderr.on('data', (d) => {
            // Capture last stderr line for diagnostics; don't spam.
            this.lastError = d.toString().trim().split('\n').pop() || null;
        });
    }
}

class WebcamService extends EventEmitter {
    constructor({ configStore, io, logger }) {
        super();
        this.configStore = configStore;
        this.io = io;
        this.logger = logger || console;
        this.cameras = new Map();   // id → Camera
    }

    init() {
        const list = this._readList();
        for (const cfg of list) this._add(cfg);
        this._broadcastList();
    }

    _readList() {
        try {
            const cams = this.configStore.get('webcam.cameras');
            return Array.isArray(cams) ? cams : [];
        } catch (_) { return []; }
    }

    _writeList() {
        const list = [...this.cameras.values()].map(c => c.cfg);
        this.configStore.set('webcam.cameras', list);
    }

    list() {
        return [...this.cameras.values()].map(c => ({
            ...c.cfg,
            online: c.online,
            lastError: c.lastError,
        }));
    }

    upsert(cfg) {
        if (!cfg.id) cfg.id = 'cam_' + Date.now().toString(36);
        const existing = this.cameras.get(cfg.id);
        if (existing) existing.stop();
        this._add(cfg);
        this._writeList();
        this._broadcastList();
        return cfg;
    }

    remove(id) {
        const cam = this.cameras.get(id);
        if (cam) cam.stop();
        this.cameras.delete(id);
        this._writeList();
        this._broadcastList();
    }

    subscribe(id, res) {
        const cam = this.cameras.get(id);
        if (!cam) { res.status(404).end(); return; }
        cam.subscribe(res);
    }

    snapshot(id) {
        const cam = this.cameras.get(id);
        return cam ? cam.snapshot() : null;
    }

    _add(cfg) {
        const cam = new Camera(cfg);
        cam.on('status', (s) => {
            this.io.emit('webcam:status', { id: cfg.id, ...s });
        });
        this.cameras.set(cfg.id, cam);
        try { cam.start(); }
        catch (e) { this.logger.error(`[webcam ${cfg.id}] start failed: ${e.message}`); }
    }

    _broadcastList() {
        this.io.emit('webcam:cameras', this.list());
    }

    shutdown() {
        for (const cam of this.cameras.values()) cam.stop();
        this.cameras.clear();
    }
}

module.exports = { WebcamService };
