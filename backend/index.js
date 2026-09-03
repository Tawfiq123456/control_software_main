/**
 * CNC backend: Express + Socket.IO + CNCEngine.
 *
 * Uses the 6-layer architecture:
 *   Layer 1: SerialConnection (hardware I/O)
 *   Layer 2: Connection (firmware detection, lifecycle)
 *   Layer 3: GrblController / GrblHalController (command handling)
 *   Layer 4: Sender (G-code streaming)
 *   Layer 5: CNCEngine (Socket.IO server) <-- this file wires it up
 *   Layer 6: Frontend controller.ts (client)
 *
 * Port: 4000 (or process.env.PORT)
 */
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { CNCEngine } = require('./services/CNCEngine');
const { WebcamService } = require('./services/webcam/WebcamService');
const { GamepadService } = require('./services/gamepad/GamepadService');
const { WatchDirService } = require('./services/watchdir/WatchDirService');
const { ProbingService } = require('./services/probing/ProbingService');
const { JobHistoryService } = require('./services/jobhistory/JobHistoryService');
const { ToolLibrary } = require('./services/toollibrary/ToolLibrary');
const { WhatsAppService } = require('./services/whatsapp/WhatsAppService');
const { TelegramBotService } = require('./services/telegram/TelegramBotService');
const { LibraryService } = require('./services/library/LibraryService');
const errlog = require('./middleware/errlog');
const errclient = require('./middleware/errclient');
const errnotfound = require('./middleware/errnotfound');
const errserver = require('./middleware/errserver');

const PORT = Number(process.env.PORT) || 4000;
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        logger.info('request', {
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            responseTime: Date.now() - start,
        });
    });
    next();
});

// Frontend logging endpoint
app.post('/api/log', (req, res) => {
    const { level = 'info', message, meta } = req.body || {};
    logger.log(level, message || 'frontend log', meta ? { frontend: meta } : {});
    res.status(204).end();
});

// Create HTTP + Socket.IO server
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: true },
    path: '/socket.io',
    serveClient: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
});

// Create CNCEngine (Layer 5)
const engine = new CNCEngine(io);

// ─── Phase A/B services (AxioCNC + gSender parity) ───────────────
const getController = () => engine.controller || null;
const dataDir = path.join(__dirname, 'data');

const webcamService     = new WebcamService({     configStore: engine.config, io, logger });
const gamepadService    = new GamepadService({    configStore: engine.config, io, logger, getController });
const watchdirService   = new WatchDirService({   configStore: engine.config, io, logger });
const probingService    = new ProbingService({    configStore: engine.config, io, logger, getController });
const jobHistoryService = new JobHistoryService({ dataDir,                    io, logger, getController });
const toolLibrary       = new ToolLibrary({       configStore: engine.config, io, logger });
const libraryService    = new LibraryService({    dataDir, io, logger });
const whatsappService   = new WhatsAppService({   configStore: engine.config, io, logger,
                                                  getController, getEngine: () => engine, dataDir,
                                                  libraryService, webcamService });
const telegramService   = new TelegramBotService({ configStore: engine.config, io, logger,
                                                   getController, getEngine: () => engine, dataDir,
                                                   libraryService, webcamService });

webcamService.init();
gamepadService.init();
watchdirService.init();
whatsappService.init();
telegramService.init();

// Re-send full state on every new socket connect.
io.on('connection', (socket) => {
    socket.emit('webcam:cameras', webcamService.list());
    socket.emit('gamepad:bindings', gamepadService.getBindings());
    socket.emit('watchdir:list', watchdirService.list());
    socket.emit('jobhistory:list', jobHistoryService.list({ limit: 50 }));
    socket.emit('tools:list', toolLibrary.list());
    socket.emit('probing:strategies', probingService.listStrategies());
    socket.emit('library:list', libraryService.list());
    {
        const ws = whatsappService.getStatus();
        socket.emit('whatsapp:status', { state: ws.state });
        socket.emit('whatsapp:config', ws.config);
        socket.emit('whatsapp:recipients', ws.config.recipients || []);
        if (ws.state === 'qr' && ws.qrDataUrl) socket.emit('whatsapp:qr', { dataUrl: ws.qrDataUrl });
    }
    {
        const ts = telegramService.getStatus();
        socket.emit('telegram:status', { state: ts.state, info: ts.info });
        socket.emit('telegram:config', ts.config);
    }
    socket.on('gamepad:axes',   (vals) => gamepadService.onAxes(vals));
    socket.on('gamepad:button', ({ index, pressed }) => gamepadService.onButton(index, pressed));
});

// ─── REST API ────────────────────────────────────────────────────

app.get('/api/ports', async (req, res) => {
    try {
        const ports = await engine.listPorts();
        res.json(ports);
    } catch (err) {
        logger.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/state', (req, res) => {
    res.json(engine.getState());
});

app.post('/api/connect', (req, res) => {
    const path = req.body.path || req.body.port;
    const baudRate = req.body.baudRate || 115200;
    const network = req.body.network || false;
    if (!path) {
        return res.status(400).json({ error: 'Missing path, port, or IP address' });
    }

    // Use a temporary socket-like object for the REST callback
    const fakeSocket = {
        id: `rest-${Date.now()}`,
        emit: () => {},
    };

    engine._handleOpen(fakeSocket, path, { baudRate, network }, (err) => {
        if (err) {
            logger.error(err);
            return res.status(500).json({ error: err.message });
        }
        res.json({
            ok: true,
            port: engine.port,
            controllerType: engine.connection?.controllerType || null,
        });
    });
});

app.post('/api/disconnect', (req, res) => {
    try {
        engine._closeConnection();
        res.json({ ok: true });
    } catch (err) {
        logger.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/command', (req, res) => {
    const cmd = req.body.command || req.body.cmd;
    const args = req.body.args || [];
    if (!cmd) return res.status(400).json({ error: 'Missing command' });
    if (!engine.controller) return res.status(400).json({ error: 'Not connected' });
    try {
        engine.controller.command(cmd, ...args);
        res.json({ ok: true });
    } catch (err) {
        logger.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Macro REST API ──────────────────────────────────────────────

app.get('/api/macros', (req, res) => {
    res.json(engine.config.getMacros());
});

app.post('/api/macros', (req, res) => {
    engine.config.saveMacro(req.body);
    res.json(engine.config.getMacros());
});

app.delete('/api/macros/:id', (req, res) => {
    engine.config.deleteMacro(req.params.id);
    res.json(engine.config.getMacros());
});

app.post('/api/macros/:id/run', (req, res) => {
    const macro = engine.config.getMacro(req.params.id);
    if (!macro) return res.status(404).json({ error: 'Macro not found' });
    if (!engine.controller) return res.status(400).json({ error: 'Not connected' });
    engine.controller.command('macro:run', macro.content);
    res.json({ ok: true });
});

// ─── Tool Library REST API ───────────────────────────────────────

app.get('/api/tools', (req, res) => {
    res.json(engine.config.getTools());
});

app.post('/api/tools', (req, res) => {
    engine.config.saveTool(req.body);
    res.json(engine.config.getTools());
});

app.delete('/api/tools/:id', (req, res) => {
    engine.config.deleteTool(req.params.id);
    res.json(engine.config.getTools());
});

// ─── Config REST API ─────────────────────────────────────────────

app.get('/api/config', (req, res) => {
    res.json(engine.config.getAll());
});

app.get('/api/config/:key', (req, res) => {
    const value = engine.config.get(req.params.key);
    res.json({ key: req.params.key, value });
});

app.post('/api/config', (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Missing key' });
    engine.config.set(key, value);
    res.json({ ok: true });
});

// ─── Health REST API ─────────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        connected: engine.controller != null,
        health: engine.controller?.getHealthMetrics() || null,
    });
});

// ─── Firmware Flashing ───────────────────────────────────────────

const FirmwareFlashing = require('./lib/Firmware/Flashing/firmwareflashing');

app.post('/api/firmware/flash', async (req, res) => {
    const { port, boardType, hexPath } = req.body;

    if (!port || !boardType) {
        return res.status(400).json({ error: 'Missing port or boardType' });
    }

    try {
        // Get socket for progress events (if available from Socket.IO connection)
        const socket = io.sockets.sockets.values().next().value;
        await FirmwareFlashing.flash(port, boardType, { hexPath, socket });
        res.json({ success: true, message: 'Firmware flashed successfully' });
    } catch (err) {
        logger.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Webcam REST ─────────────────────────────────────────────────

app.get('/api/webcam/cameras', (req, res) => res.json(webcamService.list()));
app.post('/api/webcam/cameras', (req, res) => {
    try { res.json(webcamService.upsert(req.body)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/webcam/cameras/:id', (req, res) => {
    webcamService.remove(req.params.id); res.json({ ok: true });
});
app.get('/api/webcam/stream/:id', (req, res) => {
    webcamService.subscribe(req.params.id, res);
});
app.get('/api/webcam/snapshot/:id', (req, res) => {
    const buf = webcamService.snapshot(req.params.id);
    if (!buf) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg').send(buf);
});

// ─── Gamepad REST ────────────────────────────────────────────────

app.get('/api/gamepad/bindings', (req, res) => res.json(gamepadService.getBindings()));
app.post('/api/gamepad/bindings', (req, res) => {
    gamepadService.setBindings(req.body); res.json(gamepadService.getBindings());
});

// ─── WatchDir REST ───────────────────────────────────────────────

app.get('/api/watchdir/config', (req, res) => res.json(watchdirService.getConfig()));
app.post('/api/watchdir/config', (req, res) => res.json(watchdirService.setConfig(req.body)));
app.get('/api/watchdir/files', (req, res) => res.json(watchdirService.list()));
app.get('/api/watchdir/file/:name', (req, res) => {
    try { res.type('text/plain').send(watchdirService.readFile(req.params.name)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Probing REST ────────────────────────────────────────────────

app.get('/api/probing/strategies', (req, res) => res.json(probingService.listStrategies()));
app.post('/api/probing/run', async (req, res) => {
    try { res.json(await probingService.run(req.body)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/probing/abort', (req, res) => {
    probingService.abort(); res.json({ ok: true });
});
// msg11601 item 4: operator confirms the probe/touch-plate has been
// physically removed, THEN this drops Z by plateThickness and re-zeros --
// see ProbingService.finalizeCornerZero() doc comment for why this is a
// separate human-triggered step and not part of /api/probing/run.
app.post('/api/probing/finalize-corner', async (req, res) => {
    try { res.json(await probingService.finalizeCornerZero()); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
// Probe Recorder (msg11469): persists real measured zRetract/xyReposition/
// zDrop values captured by the frontend's manual-jog-and-mark wizard, so
// these no longer need another code ship after every hardware retest.
//
// backend/data/config.json (the main ConfigStore) is gitignored -- runtime
// state only, never visible in the repo. Tawfiq (msg11476) wants the actual
// measured numbers as their own tracked file he can see/diff, so this also
// writes probe_calibration.json at the repo root, which IS committed.
const PROBE_CALIBRATION_FILE = path.join(__dirname, '..', 'probe_calibration.json');
app.post('/api/probing/record/save', (req, res) => {
    try {
        const { zRetract, xyReposition, zDrop } = req.body || {};
        if (zRetract != null) engine.config.set('probeSettings.zRetract', zRetract);
        if (xyReposition != null) engine.config.set('probeSettings.xyReposition', xyReposition);
        if (zDrop != null) engine.config.set('probeSettings.zDrop', zDrop);
        const probeSettings = engine.config.get('probeSettings');
        fs.writeFileSync(PROBE_CALIBRATION_FILE, JSON.stringify({
            zRetract: probeSettings.zRetract,
            xyReposition: probeSettings.xyReposition,
            zDrop: probeSettings.zDrop,
            recordedAt: new Date().toISOString(),
        }, null, 2) + '\n');
        res.json({ success: true, probeSettings });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Job History REST ────────────────────────────────────────────

app.get('/api/jobhistory', (req, res) => res.json(jobHistoryService.list(req.query)));
app.get('/api/jobhistory/stats', (req, res) => res.json(jobHistoryService.stats()));
app.get('/api/jobhistory/:id', (req, res) => {
    const r = jobHistoryService.get(req.params.id);
    if (!r) return res.status(404).end();
    res.json(r);
});
app.delete('/api/jobhistory', (req, res) => { jobHistoryService.clear(); res.json({ ok: true }); });
app.delete('/api/jobhistory/:id', (req, res) => { jobHistoryService.deleteOne(req.params.id); res.json({ ok: true }); });

// ─── Tool Library REST (v2 — replaces engine.config tools API) ───

app.get('/api/toollib', (req, res) => res.json(toolLibrary.list()));
app.get('/api/toollib/:number', (req, res) => {
    const t = toolLibrary.get(req.params.number);
    if (!t) return res.status(404).end();
    res.json(t);
});
app.post('/api/toollib', (req, res) => {
    try { res.json(toolLibrary.upsert(req.body)); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/toollib/:number', (req, res) => {
    toolLibrary.remove(req.params.number); res.json({ ok: true });
});
app.post('/api/toollib/preflight', (req, res) => {
    res.json(toolLibrary.preflight(req.body?.gcode || ''));
});

// ─── WhatsApp Notifications REST API ─────────────────────────────
app.get('/api/whatsapp/status', (req, res) => res.json(whatsappService.getStatus()));
app.post('/api/whatsapp/enable', async (req, res) => {
    try { res.json(await whatsappService.enable()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/whatsapp/disable', async (req, res) => {
    try { res.json(await whatsappService.disable()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/whatsapp/recipients', (req, res) => {
    try { res.json({ recipients: whatsappService.addRecipient(req.body?.phone) }); }
    catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/whatsapp/recipients/:phone', (req, res) => {
    res.json({ recipients: whatsappService.removeRecipient(req.params.phone) });
});
app.post('/api/whatsapp/events', (req, res) => {
    try { res.json(whatsappService.updateEvents(req.body?.events || [])); }
    catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/whatsapp/config', (req, res) => {
    res.json(whatsappService.updateConfig(req.body || {}));
});
app.post('/api/whatsapp/test', async (req, res) => {
    try { res.json({ results: await whatsappService.sendTest() }); }
    catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── Telegram Bot REST API ────────────────────────────────────────
app.get('/api/telegram/status', (req, res) => res.json(telegramService.getStatus()));
app.post('/api/telegram/config', (req, res) => {
    res.json(telegramService.updateConfig(req.body || {}));
});
app.post('/api/telegram/enable', async (req, res) => {
    try { res.json(await telegramService.enable()); }
    catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/telegram/disable', async (req, res) => {
    try { res.json(await telegramService.disable()); }
    catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/telegram/test', async (req, res) => {
    try { res.json(await telegramService.test()); }
    catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── Library REST API ─────────────────────────────────────────────
app.get('/api/library', (req, res) => res.json(libraryService.list()));
app.get('/api/library/:id/body', (req, res) => {
    try { res.type('text/plain').send(libraryService.getBody(req.params.id)); }
    catch (err) { res.status(404).json({ error: err.message }); }
});
app.post('/api/library', (req, res) => {
    try { res.json(libraryService.upsert(req.body || {})); }
    catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/library/:id', (req, res) => {
    libraryService.remove(req.params.id);
    res.json({ ok: true });
});

// ─── Frontend static serving (production build) ──────────────────
// Serves frontend/dist/ (built via `cd frontend && npm run build`) so the
// whole app -- backend API + Socket.IO + UI -- comes up from one process on
// one port, no separate dev server needed. Placed after all /api/* routes
// (so API paths are never shadowed by the static handler / SPA fallback)
// but before the error-handling chain. Silently no-ops (falls through to
// the 404 handler below) if dist/ hasn't been built yet, so this is safe
// to have even during backend-only development.
const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDistPath));
app.get(/^(?!\/api\/).*/, (req, res, next) => {
    // Only handle browser page navigations, not API/websocket traffic --
    // res.sendFile 404s (via the `next()` in its callback) fall through to
    // the normal error chain instead of masking a real missing-asset error.
    res.sendFile(path.join(frontendDistPath, 'index.html'), (err) => {
        if (err) next();
    });
});

// ─── Error Handling Middleware Chain ──────────────────────────────
// Order matters: 404 → log → client (JSON) → server (fallback)
app.use(errnotfound());
app.use(errlog);
app.use(errclient);
app.use(errserver());

// Start server
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
    logger.info(`CNC backend listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    logger.info('>>> BACKEND BUILD: vendor-pcap-v3 (msg 7099) — retransmit-on-B until-A + Z-runaway off');
});
