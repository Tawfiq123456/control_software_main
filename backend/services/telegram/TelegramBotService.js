/**
 * TelegramBotService
 * ─────────────────────────────────────────────────────────────────────
 *  A standalone Telegram bot that mirrors the WhatsApp bot's command
 *  surface so operators can drive the CNC from Telegram instead of
 *  whatsapp-web.js (which only logs in AS your own WA account and can't
 *  meaningfully message-yourself).
 *
 *  Configure:
 *    1. Open @BotFather → /newbot → pick name (e.g. "Onefinity_bot")
 *    2. Copy the HTTP token
 *    3. Paste it into EasyCNC → Settings → Notifications → Telegram token
 *    4. Send any message to the bot from your phone; the bot replies
 *       with your chat_id — paste that into the allow-list
 *
 *  Commands (same as WhatsApp bot):
 *    /ping     — health-check (always works)
 *    /help     — list commands
 *    /status   — machine state · position · job progress
 *    /files    — list Library files
 *    /load X   — load Library file into sender
 *    /jog X+10 — incremental jog (with bot-eye snapshot if configured)
 *    /home     — home all axes (needs YES within 30 s)
 *    /start    — start loaded file (needs YES within 30 s)
 *    /stop     — pause + feed-hold the running job
 *    /upload   — attach a .gcode/.nc/.tap with caption "/upload"
 *
 *  REST API:
 *    GET  /api/telegram/status
 *    POST /api/telegram/config      body: { token, allowedChatIds, botEnabled, botEyeCameraId }
 *    POST /api/telegram/enable
 *    POST /api/telegram/disable
 *    POST /api/telegram/test        sends "test ok" to every allowed chat
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
    token: '',                  // BotFather HTTP token
    allowedChatIds: [],         // numeric Telegram chat IDs (positive for users, negative for groups)
    openMode: true,             // if allowedChatIds empty → accept commands from any chat (first-run friendly)
    botEnabled: true,           // bot accepts slash commands
    botEyeCameraId: null,       // webcam id used for /jog snapshots
    enabled: false,             // service polling running?
};

const CONFIRMATIONS_TTL_MS = 30000;

class TelegramBotService {
    constructor({ configStore, io, logger, getController, getEngine, dataDir,
                  libraryService, webcamService }) {
        this.config = configStore;
        this.io = io;
        this.log = logger || console;
        this.getController = getController;
        this.getEngine = getEngine;
        this.dataDir = dataDir || path.join(__dirname, '..', '..', 'data');

        this.libraryService = libraryService || null;
        this.webcamService = webcamService || null;

        this.bot = null;
        this.state = 'disabled';
        this._stateInfo = '';
        this._pendingConfirms = new Map(); // chatId → { action, expiresAt }
        this._auditLog = path.join(this.dataDir, 'telegram-bot.jsonl');

        try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch (_) {}
    }

    init() {
        const cur = this._readCfg();
        const merged = { ...DEFAULT_CONFIG, ...cur };
        this._writeCfg(merged);

        if (merged.enabled && merged.token) {
            this.enable().catch((err) => {
                this.log.error?.('telegram.init.enable.failed', { err: err?.message });
                this._setState('disabled', err?.message || 'enable failed');
            });
        } else {
            this._setState('disabled');
        }
    }

    // ─── Config helpers ─────────────────────────────────────────────

    _readCfg() {
        const cfg = this.config?.get?.('telegram');
        return cfg && typeof cfg === 'object' ? cfg : {};
    }

    _writeCfg(next) {
        this.config?.set?.('telegram', next);
        // Don't leak the token over the socket — emit a redacted copy
        const safe = { ...next, token: next.token ? '••••••••' + next.token.slice(-4) : '' };
        this.io?.emit?.('telegram:config', safe);
    }

    _patchCfg(patch) {
        const merged = { ...DEFAULT_CONFIG, ...this._readCfg(), ...patch };
        this._writeCfg(merged);
        return merged;
    }

    getStatus() {
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
        return {
            state: this.state,
            info: this._stateInfo,
            config: {
                ...cfg,
                token: cfg.token ? '••••••••' + cfg.token.slice(-4) : '',
            },
        };
    }

    _setState(state, info) {
        this.state = state;
        this._stateInfo = info || '';
        this.io?.emit?.('telegram:status', { state, info: this._stateInfo });
        this.log.info?.('telegram.state', { state, info });
    }

    // ─── Lifecycle ──────────────────────────────────────────────────

    async enable() {
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
        if (!cfg.token) {
            this._setState('disabled', 'no token — paste BotFather token in Settings');
            throw new Error('Telegram bot token is empty');
        }
        if (this.bot) await this.disable();

        let TelegramBot;
        try {
            TelegramBot = require('node-telegram-bot-api');
        } catch (err) {
            this._setState('disabled', 'node-telegram-bot-api not installed — run npm install');
            throw new Error('node-telegram-bot-api is not installed. Run `npm install node-telegram-bot-api` in the backend folder.');
        }

        this._setState('init', 'starting polling…');
        try {
            this.bot = new TelegramBot(cfg.token, {
                polling: { interval: 1000, autoStart: true, params: { timeout: 30 } },
            });

            this.bot.on('polling_error', (err) => {
                const msg = err?.message || String(err);
                this.log.error?.('telegram.polling.error', { err: msg });
                if (/ETELEGRAM:\s*404|Not Found|Unauthorized/i.test(msg)) {
                    this._setState('auth_failed', 'token rejected by Telegram');
                    this.disable().catch(() => {});
                } else {
                    this._setState('reconnecting', msg);
                }
            });

            this.bot.on('message', (m) => {
                this._handleIncoming(m).catch((err) =>
                    this.log.error?.('telegram.bot.error', { err: err?.message, stack: err?.stack }));
            });

            // Wait for getMe to confirm token works
            const me = await this.bot.getMe();
            this._patchCfg({ enabled: true });
            this._setState('ready', `connected as @${me.username}`);
            this._sendWelcomePing(me).catch(() => {});

            return { ok: true, username: me.username };
        } catch (err) {
            this._setState('disabled', err?.message || 'connect failed');
            try { await this.bot?.stopPolling(); } catch (_) {}
            this.bot = null;
            throw err;
        }
    }

    async disable() {
        try { await this.bot?.stopPolling(); }
        catch (err) { this.log.warn?.('telegram.stop.failed', { err: err?.message }); }
        this.bot = null;
        this._patchCfg({ enabled: false });
        this._setState('disabled', 'stopped');
        return { ok: true };
    }

    updateConfig(patch) {
        const clean = {};
        if (typeof patch.token === 'string') clean.token = patch.token.trim();
        if (Array.isArray(patch.allowedChatIds)) {
            clean.allowedChatIds = patch.allowedChatIds
                .map((x) => Number(x))
                .filter((n) => Number.isFinite(n));
        }
        if (typeof patch.botEnabled === 'boolean') clean.botEnabled = patch.botEnabled;
        if (typeof patch.openMode === 'boolean') clean.openMode = patch.openMode;
        if (patch.botEyeCameraId === null || typeof patch.botEyeCameraId === 'string') {
            clean.botEyeCameraId = patch.botEyeCameraId;
        }
        return this._patchCfg(clean);
    }

    async test() {
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
        if (!this.bot) throw new Error('Bot is not connected');
        if (!cfg.allowedChatIds.length) throw new Error('No allowed chat IDs');
        for (const id of cfg.allowedChatIds) {
            await this.bot.sendMessage(id, 'test ok — EasyCNC Telegram bot');
        }
        return { ok: true, sent: cfg.allowedChatIds.length };
    }

    // ─── Incoming dispatch ─────────────────────────────────────────

    async _handleIncoming(msg) {
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
        const chatId = msg.chat?.id;
        const text = (msg.text || msg.caption || '').trim();
        const allowed = Array.isArray(cfg.allowedChatIds) ? cfg.allowedChatIds : [];

        if (!chatId) return;

        // /ping always works — never silently dropped
        if (/^\/ping\b/i.test(text)) {
            const status = `pong — bot ${cfg.botEnabled ? 'ON' : 'OFF'}, allowed=${allowed.length}, open=${cfg.openMode && allowed.length === 0 ? 'yes' : 'no'}, your chat_id: ${chatId}`;
            await this._reply(chatId, status);
            this._auditWrite({ chatId, cmd: '/ping', result: 'pong' });
            return;
        }

        if (!cfg.botEnabled) {
            if (text.startsWith('/')) {
                await this._reply(chatId, 'Bot is OFF. Enable it in EasyCNC → Settings → Notifications → "Telegram bot enabled".');
            }
            return;
        }

        const authorized = allowed.includes(chatId) || (cfg.openMode && allowed.length === 0);
        if (!authorized) {
            if (text.startsWith('/')) {
                await this._reply(chatId, `Not authorized. Ask the operator to add chat_id ${chatId} to Settings → Notifications → Allowed chats.`);
            }
            return;
        }

        // YES confirmation
        if (/^yes$/i.test(text)) {
            const pending = this._pendingConfirms.get(chatId);
            if (pending && Date.now() < pending.expiresAt) {
                this._pendingConfirms.delete(chatId);
                return this._runConfirmed(chatId, pending);
            }
            await this._reply(chatId, 'Nothing pending to confirm. Send a command first.');
            return;
        }

        // /upload via document attachment
        if (msg.document && /\/upload\b/i.test(text)) {
            return this._cmdUpload(chatId, msg);
        }

        if (!text.startsWith('/')) return;
        const [raw, ...args] = text.split(/\s+/);
        // Telegram allows /cmd@botname — strip the @suffix
        const cmd = raw.toLowerCase().split('@')[0];

        const handlers = {
            '/help':    () => this._cmdHelp(chatId),
            '/start':   () => this._needsConfirm(chatId, 'start', 'Send YES within 30 s to start the loaded file.'),
            '/status':  () => this._cmdStatus(chatId),
            '/files':   () => this._cmdFiles(chatId),
            '/load':    () => this._cmdLoad(chatId, args.join(' ')),
            '/jog':     () => this._cmdJog(chatId, args),
            '/stop':    () => this._cmdStop(chatId),
            '/home':    () => this._needsConfirm(chatId, 'home', 'Send YES within 30 s to home all axes.'),
            '/upload':  () => this._cmdUploadHint(chatId),
        };

        const fn = handlers[cmd];
        if (!fn) {
            await this._reply(chatId, `Unknown command: ${cmd}. Send /help for the list.`);
            this._auditWrite({ chatId, cmd, ok: false, reason: 'unknown' });
            return;
        }
        await fn();
    }

    // ─── YES-confirmation flow ─────────────────────────────────────

    async _needsConfirm(chatId, action, prompt) {
        this._pendingConfirms.set(chatId, { action, expiresAt: Date.now() + CONFIRMATIONS_TTL_MS });
        await this._reply(chatId, prompt);
        this._auditWrite({ chatId, cmd: `/${action}`, ok: true, stage: 'awaiting-confirm' });
    }

    async _runConfirmed(chatId, pending) {
        if (pending.action === 'home')  return this._cmdHomeRun(chatId);
        if (pending.action === 'start') return this._cmdStartRun(chatId);
    }

    // ─── Command handlers ──────────────────────────────────────────

    async _cmdHelp(chatId) {
        const help = [
            '*EasyCNC bot — commands*',
            '/ping — bot health-check (always works)',
            '/status — current state · position · progress',
            '/files — list saved Library files',
            '/load <name> — load Library file into sender',
            '/jog X+10 / Y-5 / Z+0.5 — incremental jog',
            '/home — home all axes (needs YES)',
            '/start — start loaded file (needs YES)',
            '/stop — pause + feed-hold the running job',
            '/upload — send a G-code file with caption "/upload"',
        ].join('\n');
        await this._reply(chatId, help, { parse_mode: 'Markdown' });
        this._auditWrite({ chatId, cmd: '/help', ok: true });
    }

    async _cmdStatus(chatId) {
        const ctl = this.getController?.();
        const state = ctl?.state || {};
        const sender = ctl?.getSenderStatus?.() || {};
        const mpos = state?.mpos || { x: 0, y: 0, z: 0 };
        const machineState = state?.status?.activeState || ctl?.state?.machineState || '?';
        const total = sender.total || 0;
        const sent  = sender.sent  || 0;
        const pct   = total ? Math.round((sent / total) * 100) : 0;
        const lines = [
            `*Machine state:* ${machineState}`,
            `*Position:* X ${this._n(mpos.x)} Y ${this._n(mpos.y)} Z ${this._n(mpos.z)} mm`,
            total ? `*Job:* line ${sent}/${total} · ${pct}%` : '*Job:* no file streaming',
            sender.elapsedMs ? `*Elapsed:* ${this._duration(Date.now() - sender.elapsedMs)}` : '',
        ].filter(Boolean);
        await this._reply(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
        this._auditWrite({ chatId, cmd: '/status', ok: true });
    }

    async _cmdFiles(chatId) {
        if (!this.libraryService) { await this._reply(chatId, 'Library service not available.'); return; }
        const items = this.libraryService.list();
        if (!items.length) { await this._reply(chatId, 'No files in Library. Send a G-code file with caption "/upload".'); return; }
        const lines = ['*Library files:*'];
        items.slice(0, 20).forEach((it, i) => {
            lines.push(`${i + 1}. ${it.name} (${this._sizeStr(it.size)})`);
        });
        if (items.length > 20) lines.push(`… +${items.length - 20} more`);
        await this._reply(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
        this._auditWrite({ chatId, cmd: '/files', ok: true });
    }

    async _cmdLoad(chatId, name) {
        if (!this.libraryService) { await this._reply(chatId, 'Library service not available.'); return; }
        if (!name) { await this._reply(chatId, 'Usage: /load <name>. Send /files to see available names.'); return; }
        const items = this.libraryService.list();
        const it = items.find((i) => i.name.toLowerCase() === name.toLowerCase()
                                  || i.fileName.toLowerCase() === name.toLowerCase());
        if (!it) { await this._reply(chatId, `No Library file matches "${name}". Try /files.`); return; }
        const ctl = this.getController?.();
        if (!ctl) { await this._reply(chatId, 'No controller connected.'); return; }
        try {
            const body = this.libraryService.getBody(it.id);
            if (typeof ctl.loadFile === 'function') {
                ctl.loadFile({ name: it.fileName, body, lines: it.lineCount });
            } else if (typeof ctl.sender?.load === 'function') {
                ctl.sender.load(body.split(/\r?\n/));
            }
            await this._reply(chatId, `Loaded *${it.name}* (${it.lineCount || '?'} lines). Send /start to run.`, { parse_mode: 'Markdown' });
            this._auditWrite({ chatId, cmd: '/load', arg: name, ok: true });
        } catch (err) {
            await this._reply(chatId, `Load failed: ${err.message}`);
            this._auditWrite({ chatId, cmd: '/load', arg: name, ok: false, error: err.message });
        }
    }

    async _cmdJog(chatId, args) {
        const ctl = this.getController?.();
        if (!ctl) { await this._reply(chatId, 'No controller connected.'); return; }
        const spec = (args[0] || '').toUpperCase();
        const m = spec.match(/^([XYZ])([+-]?\d+(?:\.\d+)?)$/);
        if (!m) { await this._reply(chatId, 'Usage: /jog X+10  or /jog Y-5  or /jog Z+0.5'); return; }
        const axis = m[1];
        const dist = parseFloat(m[2]);
        if (!isFinite(dist) || dist === 0) { await this._reply(chatId, 'Invalid distance.'); return; }
        const feed = axis === 'Z' ? 500 : 2000;
        const gcode = `$J=G91 G21 ${axis}${dist} F${feed}`;
        try {
            ctl.command?.('jog', gcode);
            await this._reply(chatId, `Jogging ${axis}${dist > 0 ? '+' : ''}${dist} mm…`);

            const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
            if (cfg.botEyeCameraId && this.webcamService?.snapshot) {
                await new Promise((r) => setTimeout(r, 1500));
                try {
                    const buf = this.webcamService.snapshot(cfg.botEyeCameraId);
                    if (buf && buf.length) {
                        await this.bot.sendPhoto(chatId, buf, { caption: 'After jog' });
                    }
                } catch (err) { this.log.warn?.('telegram.bot.snap.failed', { err: err?.message }); }
            }
            this._auditWrite({ chatId, cmd: '/jog', arg: spec, ok: true });
        } catch (err) {
            await this._reply(chatId, `Jog failed: ${err.message}`);
            this._auditWrite({ chatId, cmd: '/jog', arg: spec, ok: false, error: err.message });
        }
    }

    async _cmdStop(chatId) {
        const ctl = this.getController?.();
        if (!ctl) { await this._reply(chatId, 'No controller connected.'); return; }
        try {
            ctl.command?.('pause');
            ctl.command?.('feedhold');
            await this._reply(chatId, '⏸ Stopped. Send /start to resume from beginning, or use the host UI to resume.');
            this._auditWrite({ chatId, cmd: '/stop', ok: true });
        } catch (err) {
            await this._reply(chatId, `Stop failed: ${err.message}`);
            this._auditWrite({ chatId, cmd: '/stop', ok: false, error: err.message });
        }
    }

    async _cmdHomeRun(chatId) {
        const ctl = this.getController?.();
        if (!ctl) { await this._reply(chatId, 'No controller connected.'); return; }
        try {
            ctl.command?.('homing');
            await this._reply(chatId, 'Homing all axes…');
            this._auditWrite({ chatId, cmd: '/home', ok: true, stage: 'fired' });
        } catch (err) {
            await this._reply(chatId, `Home failed: ${err.message}`);
            this._auditWrite({ chatId, cmd: '/home', ok: false, error: err.message });
        }
    }

    async _cmdStartRun(chatId) {
        const ctl = this.getController?.();
        if (!ctl) { await this._reply(chatId, 'No controller connected.'); return; }
        try {
            ctl.command?.('cyclestart');
            await this._reply(chatId, '▶ Starting…');
            this._auditWrite({ chatId, cmd: '/start', ok: true, stage: 'fired' });
        } catch (err) {
            await this._reply(chatId, `Start failed: ${err.message}`);
            this._auditWrite({ chatId, cmd: '/start', ok: false, error: err.message });
        }
    }

    async _cmdUpload(chatId, msg) {
        if (!this.libraryService) { await this._reply(chatId, 'Library service not available.'); return; }
        try {
            const doc = msg.document;
            const fileName = doc.file_name || `bot-upload-${Date.now()}.gcode`;
            const fileLink = await this.bot.getFileLink(doc.file_id);
            const res = await fetch(fileLink);
            if (!res.ok) throw new Error(`Telegram file fetch HTTP ${res.status}`);
            const body = await res.text();
            const name = fileName.replace(/\.[^.]+$/, '');
            const entry = this.libraryService.upsert({ name, fileName, body });
            await this._reply(chatId, `✓ Saved *${entry.name}* to Library (${entry.lineCount} lines · ${this._sizeStr(entry.size)}). Send /load ${entry.name} to use it.`, { parse_mode: 'Markdown' });
            this._auditWrite({ chatId, cmd: '/upload', arg: fileName, ok: true });
        } catch (err) {
            await this._reply(chatId, `Upload failed: ${err.message}`);
            this._auditWrite({ chatId, cmd: '/upload', ok: false, error: err.message });
        }
    }

    async _cmdUploadHint(chatId) {
        await this._reply(chatId, 'Attach a G-code file (.gcode / .nc / .tap) to your next message and add the caption */upload*.', { parse_mode: 'Markdown' });
        this._auditWrite({ chatId, cmd: '/upload', ok: true, stage: 'hint' });
    }

    // ─── helpers ───────────────────────────────────────────────────

    async _reply(chatId, text, opts) {
        if (!this.bot) return;
        try { await this.bot.sendMessage(chatId, text, opts); }
        catch (err) { this.log.warn?.('telegram.reply.failed', { err: err?.message }); }
    }

    async _sendWelcomePing(me) {
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
        const allowed = Array.isArray(cfg.allowedChatIds) ? cfg.allowedChatIds : [];
        if (!allowed.length) return;
        const banner = [
            `*EasyCNC bot online* — @${me.username}`,
            cfg.botEnabled ? 'Bot is ON. Send /help for commands or /ping to verify.' : 'Bot is OFF — enable it in EasyCNC → Settings → Notifications.',
        ].join('\n');
        for (const id of allowed) {
            try { await this.bot.sendMessage(id, banner, { parse_mode: 'Markdown' }); }
            catch (_) {}
        }
        this._auditWrite({ event: 'welcome', allowed: allowed.length, botEnabled: cfg.botEnabled });
    }

    _auditWrite(entry) {
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
        try { fs.appendFileSync(this._auditLog, line); }
        catch (err) { this.log.warn?.('telegram.audit.write.failed', { err: err?.message }); }
        this.io?.emit?.('telegram:bot:log', { ts: new Date().toISOString(), ...entry });
    }

    _n(v) { return (Number(v) || 0).toFixed(3); }

    _sizeStr(bytes) {
        if (!bytes) return '0 B';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    _duration(ms) {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        if (h) return `${h}h${m % 60}m`;
        if (m) return `${m}m${s % 60}s`;
        return `${s}s`;
    }
}

module.exports = { TelegramBotService };
