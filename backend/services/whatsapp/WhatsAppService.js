/**
 * WhatsAppService — live job notifications to user phones via whatsapp-web.js.
 *
 * Architecture:
 *   - Lazy-loads whatsapp-web.js + qrcode only when enable() is called, so a
 *     missing native dep can't crash the rest of the backend.
 *   - Persists session via LocalAuth (./data/whatsapp-session/) so QR scan is
 *     a one-time setup.
 *   - Subscribes to controller + sender + engine events; formats and sends
 *     to all configured recipients with per-event throttling.
 *
 * Config keys (ConfigStore):
 *   whatsapp.enabled          boolean   default false
 *   whatsapp.recipients       string[]  E.164 with country code, e.g. "+919876543210"
 *   whatsapp.events           string[]  subset of EVENT_KEYS
 *   whatsapp.minIntervalSec   number    minimum seconds between same-event sends (default 30)
 *   whatsapp.includePosition  boolean   include machine X/Y/Z in messages (default true)
 *
 * Socket.IO events emitted:
 *   whatsapp:status   { state: 'disabled'|'init'|'qr'|'ready'|'auth_failed'|'disconnected', info?: string }
 *   whatsapp:qr       { dataUrl: string }   - base64 PNG of the WhatsApp pairing QR
 *   whatsapp:recipients   string[]
 *   whatsapp:config   the full whatsapp.* config block
 *
 * REST routes wired in index.js:
 *   GET    /api/whatsapp/status
 *   POST   /api/whatsapp/enable
 *   POST   /api/whatsapp/disable
 *   POST   /api/whatsapp/recipients          body: { phone }
 *   DELETE /api/whatsapp/recipients/:phone
 *   POST   /api/whatsapp/events              body: { events: string[] }
 *   POST   /api/whatsapp/test                send "test ok" to all recipients
 */

const path = require('path');
const fs = require('fs');

const EVENT_KEYS = [
    'connected',       // controller connected
    'disconnected',    // controller disconnected
    'job:start',       // gcode streaming started
    'job:pause',       // job paused
    'job:resume',      // job resumed
    'job:end',         // job finished ok
    'job:stop',        // job aborted by user
    'job:error',       // sender error
    'alarm',           // controller alarm
    'emergency',       // E-stop / motor error
];

const DEFAULT_CONFIG = {
    enabled: false,
    recipients: [],
    events: ['connected', 'job:start', 'job:end', 'job:error', 'alarm', 'emergency'],
    minIntervalSec: 30,
    includePosition: true,
    botEnabled: true,          // accept slash commands from recipients (Tawfiq msg 7432 → on by default)
    botEyeCameraId: null,      // webcam id used for /jog snapshots
    botOpenMode: true,         // if recipients[] is empty, accept commands from ANY sender (first-run friendly)
};

// Slash-command catalog (Tawfiq msg 7430). Destructive commands need
// "YES" within 30 s before they fire.
const CONFIRMATIONS_TTL_MS = 30000;

class WhatsAppService {
    constructor({ configStore, io, logger, getController, getEngine, dataDir,
                  libraryService, webcamService }) {
        this.config = configStore;
        this.io = io;
        this.log = logger || console;
        this.getController = getController;
        this.getEngine = getEngine;
        this.dataDir = dataDir || path.join(__dirname, '..', '..', 'data');

        // Optional sibling services — bot commands route through them.
        this.libraryService = libraryService || null;
        this.webcamService = webcamService || null;

        this.client = null;
        this.state = 'disabled';
        this.lastQrDataUrl = null;
        this.lastSentAt = new Map();
        this.pendingHooks = false;
        this._currentJobMeta = null;

        // Bot state — pending YES confirmations keyed by sender phone.
        this._pendingConfirms = new Map();

        // Bot audit log path
        this._auditLog = path.join(this.dataDir, 'whatsapp-bot.jsonl');
    }

    init() {
        // Ensure config has defaults
        const cur = this._readCfg();
        const merged = { ...DEFAULT_CONFIG, ...cur };
        this._writeCfg(merged);

        if (merged.enabled) {
            this.enable().catch((err) => {
                this.log.error?.('whatsapp.init.enable.failed', { err: err?.message });
                this._setState('disabled', err?.message || 'enable failed');
            });
        } else {
            this._setState('disabled');
        }
    }

    // ─── Config helpers ─────────────────────────────────────────────

    _readCfg() {
        const cfg = this.config?.get?.('whatsapp');
        return cfg && typeof cfg === 'object' ? cfg : {};
    }

    _writeCfg(next) {
        this.config?.set?.('whatsapp', next);
        this.io?.emit?.('whatsapp:config', next);
    }

    _patchCfg(patch) {
        const merged = { ...DEFAULT_CONFIG, ...this._readCfg(), ...patch };
        this._writeCfg(merged);
        return merged;
    }

    getStatus() {
        return {
            state: this.state,
            qrDataUrl: this.state === 'qr' ? this.lastQrDataUrl : null,
            config: { ...DEFAULT_CONFIG, ...this._readCfg() },
        };
    }

    // ─── Lifecycle ──────────────────────────────────────────────────

    async enable() {
        if (this.client) return this.getStatus();

        let whatsappLib, qrcodeLib;
        try {
            whatsappLib = require('whatsapp-web.js');
            qrcodeLib = require('qrcode');
        } catch (err) {
            this._setState('disabled', `Native deps missing — cd backend && npm install. ${err.message}`);
            throw err;
        }

        const { Client, LocalAuth } = whatsappLib;
        const sessionDir = path.join(this.dataDir, 'whatsapp-session');

        // Auto-create session dir so LocalAuth doesn't fail silently when
        // backend/data/ is fresh (Tawfiq audit msg 7424).
        try { fs.mkdirSync(sessionDir, { recursive: true }); }
        catch (err) { this.log.warn?.('whatsapp.session.mkdir.failed', { err: err?.message }); }

        // Optional pointer to an existing Chrome/Chromium install — set
        // WA_CHROME_PATH in backend/.env to skip the ~280 MB puppeteer
        // Chromium download. e.g. C:\Program Files\Google\Chrome\Application\chrome.exe
        const executablePath = process.env.WA_CHROME_PATH || undefined;

        this._setState('init', executablePath
            ? `starting WhatsApp client (system Chrome at ${executablePath})…`
            : 'starting WhatsApp client (bundled Chromium)…');

        this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: sessionDir }),
            puppeteer: {
                headless: true,
                executablePath,
                timeout: 60000,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                ],
            },
        });

        this.client.on('qr', async (qr) => {
            try {
                this.lastQrDataUrl = await qrcodeLib.toDataURL(qr, { margin: 1, width: 320 });
                this._setState('qr', 'scan with WhatsApp on your phone');
                this.io?.emit?.('whatsapp:qr', { dataUrl: this.lastQrDataUrl });
            } catch (err) {
                this.log.error?.('whatsapp.qr.encode.failed', { err: err?.message });
            }
        });

        this.client.on('authenticated', () => {
            this._setState('init', 'authenticated, loading session…');
        });

        this.client.on('auth_failure', (msg) => {
            this._setState('auth_failed', msg || 'authentication failed');
        });

        this.client.on('ready', () => {
            this.lastQrDataUrl = null;
            const me = this.client?.info?.wid?._serialized || 'unknown';
            this._setState('ready', `connected as ${me}`);
            this._patchCfg({ enabled: true });
            this._wireHooks();
            this._wireBot();
            // Welcome ping — fire-and-forget. If no recipients are configured
            // the user can still send /ping to discover the bot.
            this._sendWelcomePing().catch((err) =>
                this.log.error?.('whatsapp.bot.welcome.failed', { err: err?.message }));
        });

        this.client.on('disconnected', (reason) => {
            this._setState('disconnected', String(reason || 'disconnected'));
        });

        try {
            // 90 s hard cap on Chromium launch + WA login page load.
            // Without this, a broken puppeteer install hangs forever and
            // the operator just sees "Starting…" with no error feedback.
            await Promise.race([
                this.client.initialize(),
                new Promise((_, rej) => setTimeout(
                    () => rej(new Error('Chromium launch timed out after 90s — set WA_CHROME_PATH to your system Chrome or run "npm install" again')),
                    90000,
                )),
            ]);
        } catch (err) {
            this.log.error?.('whatsapp.init.failed', { err: err?.message, stack: err?.stack });
            this._setState('disabled', err?.message || 'puppeteer failed');
            try { await this.client?.destroy(); } catch (_) {}
            this.client = null;
            throw err;
        }

        return this.getStatus();
    }

    async disable() {
        this._patchCfg({ enabled: false });
        if (this.client) {
            try { await this.client.destroy(); } catch (_) {}
            this.client = null;
        }
        this.pendingHooks = false;
        this.lastQrDataUrl = null;
        this._setState('disabled', 'disabled by user');
        return this.getStatus();
    }

    _setState(state, info) {
        this.state = state;
        this.io?.emit?.('whatsapp:status', { state, info });
        this.log.info?.('whatsapp.state', { state, info });
    }

    // ─── Recipients ─────────────────────────────────────────────────

    addRecipient(phone) {
        const norm = this._normalizePhone(phone);
        if (!norm) throw new Error('Invalid phone. Use E.164 format, e.g. +919876543210');
        const cfg = this._readCfg();
        const list = Array.isArray(cfg.recipients) ? cfg.recipients : [];
        if (list.includes(norm)) return list;
        const next = [...list, norm];
        this._patchCfg({ recipients: next });
        this.io?.emit?.('whatsapp:recipients', next);
        return next;
    }

    removeRecipient(phone) {
        const norm = this._normalizePhone(phone);
        const cfg = this._readCfg();
        const list = Array.isArray(cfg.recipients) ? cfg.recipients : [];
        const next = list.filter((p) => p !== norm);
        this._patchCfg({ recipients: next });
        this.io?.emit?.('whatsapp:recipients', next);
        return next;
    }

    listRecipients() {
        const cfg = this._readCfg();
        return Array.isArray(cfg.recipients) ? cfg.recipients : [];
    }

    _normalizePhone(raw) {
        if (!raw) return null;
        const s = String(raw).trim();
        if (!/^\+?\d{8,15}$/.test(s.replace(/\s|-/g, ''))) return null;
        const digits = s.replace(/\D/g, '');
        return '+' + digits;
    }

    _phoneToChatId(phone) {
        return phone.replace(/\D/g, '') + '@c.us';
    }

    // ─── Event hooks ────────────────────────────────────────────────

    _wireHooks() {
        if (this.pendingHooks) return;
        this.pendingHooks = true;

        const engine = this.getEngine?.();
        const ctl = this.getController?.();

        if (engine?.on) {
            engine.on?.('controller:initialized', (info) => this._fire('connected', { info }));
        }
        if (ctl?.on) this._attachController(ctl);

        // Re-wire when controller swaps (connect/disconnect)
        if (engine?.on) {
            engine.on?.('controller:swap', (next) => {
                if (next?.on) this._attachController(next);
            });
        }
    }

    _attachController(ctl) {
        ctl.on('sender:start', (data) => {
            this._currentJobMeta = { startedAt: Date.now(), total: data?.total, filename: data?.name };
            this._fire('job:start', data);
        });
        ctl.on('sender:end',    (data) => this._fire('job:end', data));
        ctl.on('sender:error',  (err)  => this._fire('job:error', { error: err?.message || String(err) }));
        ctl.on('sender:hold',   (data) => this._fire('job:pause', data));
        ctl.on('sender:unhold', (data) => this._fire('job:resume', data));
        ctl.on('sender:abort',  ()     => this._fire('job:stop', this._currentJobMeta || {}));
        ctl.on('alarm',         (a)    => this._fire('alarm', a));
        ctl.on('emergency',     (e)    => this._fire('emergency', e));
    }

    // ─── Send pipeline ──────────────────────────────────────────────

    _fire(eventKey, payload) {
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
        if (!cfg.enabled) return;
        if (this.state !== 'ready') return;
        if (!cfg.events.includes(eventKey)) return;
        if (!cfg.recipients.length) return;

        const minMs = (cfg.minIntervalSec || 30) * 1000;
        const last = this.lastSentAt.get(eventKey) || 0;
        if (Date.now() - last < minMs) {
            this.log.debug?.('whatsapp.throttled', { eventKey });
            return;
        }
        this.lastSentAt.set(eventKey, Date.now());

        const msg = this._format(eventKey, payload, cfg);
        if (!msg) return;
        for (const phone of cfg.recipients) {
            const chatId = this._phoneToChatId(phone);
            this.client.sendMessage(chatId, msg).catch((err) => {
                this.log.error?.('whatsapp.send.failed', { phone, err: err?.message });
            });
        }
    }

    _format(eventKey, payload, cfg) {
        const ctl = this.getController?.();
        const state = ctl?.state || {};
        const ts = new Date().toLocaleString('en-IN', { hour12: false });
        const posLine = cfg.includePosition
            ? `Pos X${this._n(state?.mpos?.x)} Y${this._n(state?.mpos?.y)} Z${this._n(state?.mpos?.z)}`
            : '';

        switch (eventKey) {
            case 'connected':
                return `🟢 *EasyCNC connected*\n${payload?.info?.firmwareType || ''} ${payload?.info?.firmwareVersion || ''}\n${ts}`;
            case 'disconnected':
                return `🔴 *EasyCNC disconnected*\n${ts}`;
            case 'job:start': {
                const f = payload?.name || this._currentJobMeta?.filename || 'job';
                const total = payload?.total || this._currentJobMeta?.total || '?';
                return `▶️ *Job started*\n${f}\nLines: ${total}\n${ts}`;
            }
            case 'job:pause':
                return `⏸️ *Job paused*\nLine ${payload?.sent || '?'}/${payload?.total || '?'}\n${posLine}\n${ts}`.trim();
            case 'job:resume':
                return `▶️ *Job resumed*\nLine ${payload?.sent || '?'}/${payload?.total || '?'}\n${ts}`;
            case 'job:end': {
                const dur = this._duration(this._currentJobMeta?.startedAt);
                const f = this._currentJobMeta?.filename || payload?.name || 'job';
                this._currentJobMeta = null;
                return `✅ *Job complete*\n${f}\nDuration: ${dur}\n${ts}`;
            }
            case 'job:stop':
                return `⏹️ *Job stopped*\nLine ${payload?.sent || '?'}/${payload?.total || '?'}\n${posLine}\n${ts}`.trim();
            case 'job:error':
                return `❌ *Job FAILED*\nError: ${payload?.error || 'unknown'}\n${posLine}\n${ts}`.trim();
            case 'alarm':
                return `🚨 *ALARM*\nCode: ${payload?.code || payload?.alarm || '?'}\n${payload?.message || ''}\n${posLine}\n${ts}`.trim();
            case 'emergency':
                return `🛑 *EMERGENCY STOP*\n${payload?.reason || payload?.message || 'machine halted'}\n${posLine}\n${ts}`.trim();
            default:
                return null;
        }
    }

    _n(v) {
        if (v == null || Number.isNaN(Number(v))) return '?';
        return Number(v).toFixed(3);
    }

    _duration(startedAt) {
        if (!startedAt) return '?';
        const sec = Math.round((Date.now() - startedAt) / 1000);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return h ? `${h}h ${m}m ${s}s` : (m ? `${m}m ${s}s` : `${s}s`);
    }

    // ─── Test ──────────────────────────────────────────────────────

    async sendTest() {
        if (this.state !== 'ready') throw new Error(`WhatsApp not ready (state=${this.state})`);
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
        if (!cfg.recipients.length) throw new Error('No recipients configured');
        const msg = `✅ *EasyCNC test*\nWhatsApp notifications are working.\n${new Date().toLocaleString('en-IN', { hour12: false })}`;
        const results = [];
        for (const phone of cfg.recipients) {
            const chatId = this._phoneToChatId(phone);
            try {
                await this.client.sendMessage(chatId, msg);
                results.push({ phone, ok: true });
            } catch (err) {
                results.push({ phone, ok: false, error: err?.message });
            }
        }
        return results;
    }

    updateEvents(events) {
        if (!Array.isArray(events)) throw new Error('events must be an array');
        const valid = events.filter((e) => EVENT_KEYS.includes(e));
        const next = this._patchCfg({ events: valid });
        return next;
    }

    updateConfig(patch) {
        const clean = {};
        if (typeof patch.minIntervalSec === 'number') clean.minIntervalSec = Math.max(0, patch.minIntervalSec);
        if (typeof patch.includePosition === 'boolean') clean.includePosition = patch.includePosition;
        if (typeof patch.botEnabled === 'boolean') clean.botEnabled = patch.botEnabled;
        if (patch.botEyeCameraId === null || typeof patch.botEyeCameraId === 'string') {
            clean.botEyeCameraId = patch.botEyeCameraId;
        }
        return this._patchCfg(clean);
    }

    // ════════════════════════════════════════════════════════════════
    // ─── BOT (slash commands) — Tawfiq msg 7430 / 7432 ──────────────
    // ════════════════════════════════════════════════════════════════

    _wireBot() {
        if (!this.client || !this.client.on) return;
        this.client.on('message', async (msg) => {
            try { await this._handleIncoming(msg); }
            catch (err) { this.log.error?.('whatsapp.bot.error', { err: err?.message, stack: err?.stack }); }
        });
    }

    async _handleIncoming(msg) {
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };

        // Ignore our own messages (otherwise the bot reacts to its own status pings)
        if (msg.fromMe) return;
        // WhatsApp Web sometimes delivers status broadcasts — skip
        if ((msg.from || '').endsWith('@broadcast')) return;

        const from = msg.from || '';
        const phone = '+' + from.split('@')[0].replace(/\D/g, '');
        const text = (msg.body || '').trim();
        const recipients = Array.isArray(cfg.recipients) ? cfg.recipients : [];

        // /ping always works — diagnostic command, ignores botEnabled/recipients
        if (/^\/ping\b/i.test(text)) {
            const status = `pong — bot ${cfg.botEnabled ? 'ON' : 'OFF'}, recipients=${recipients.length}, open=${cfg.botOpenMode && recipients.length === 0 ? 'yes' : 'no'}, your phone: ${phone}`;
            try { await msg.reply(status); } catch (_) {}
            this._auditWrite({ from: phone, cmd: '/ping', result: 'pong', ts: Date.now() });
            return;
        }

        if (!cfg.botEnabled) {
            // One-time hint per phone so the user knows the bot heard them but is disabled
            if (text.startsWith('/')) {
                try { await msg.reply('Bot is OFF. Enable it in EasyCNC → Settings → Notifications → "Bot commands enabled", then resend.'); } catch (_) {}
            }
            return;
        }

        // Auth: phone in recipients OR (open mode AND recipients list is empty)
        const authorized = recipients.includes(phone) || (cfg.botOpenMode && recipients.length === 0);
        if (!authorized) {
            if (text.startsWith('/')) {
                try { await msg.reply(`Not authorized. Ask the operator to add ${phone} to Settings → Notifications → Recipients.`); } catch (_) {}
            }
            return;
        }

        // YES confirmation flow
        if (/^yes$/i.test(text)) {
            const pending = this._pendingConfirms.get(phone);
            if (pending && Date.now() < pending.expiresAt) {
                this._pendingConfirms.delete(phone);
                return this._runConfirmed(phone, pending);
            }
            await msg.reply('Nothing pending to confirm. Send a command first.');
            return;
        }

        // File upload via attached media (any message with media + caption "/upload")
        if (msg.hasMedia && /\/upload\b/i.test(text)) {
            return this._cmdUpload(phone, msg);
        }

        if (!text.startsWith('/')) return;
        const [raw, ...args] = text.split(/\s+/);
        const cmd = raw.toLowerCase();

        const handlers = {
            '/help':    () => this._cmdHelp(phone, msg),
            '/status':  () => this._cmdStatus(phone, msg),
            '/files':   () => this._cmdFiles(phone, msg),
            '/load':    () => this._cmdLoad(phone, msg, args.join(' ')),
            '/jog':     () => this._cmdJog(phone, msg, args),
            '/stop':    () => this._cmdStop(phone, msg),
            '/upload':  () => this._cmdUploadHint(phone, msg),
            // destructive — require confirmation
            '/home':    () => this._askConfirm(phone, msg, 'home', 'Home ALL axes? Reply YES within 30 s.'),
            '/start':   () => this._askConfirm(phone, msg, 'start', 'Start the loaded G-code? Make sure the machine area is CLEAR. Reply YES within 30 s.'),
        };

        const fn = handlers[cmd];
        if (!fn) {
            await msg.reply(`Unknown command "${cmd}". Send /help for the list.`);
            this._auditWrite({ phone, cmd, ok: false, reason: 'unknown' });
            return;
        }
        await fn();
    }

    async _askConfirm(phone, msg, action, prompt) {
        this._pendingConfirms.set(phone, { action, expiresAt: Date.now() + CONFIRMATIONS_TTL_MS });
        await msg.reply(prompt);
        this._auditWrite({ phone, cmd: `/${action}`, ok: true, stage: 'awaiting-confirm' });
    }

    async _runConfirmed(phone, pending) {
        if (pending.action === 'home')  return this._cmdHomeRun(phone);
        if (pending.action === 'start') return this._cmdStartRun(phone);
    }

    // ─── individual commands ───────────────────────────────────────

    async _cmdHelp(phone, msg) {
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
        await msg.reply(help);
        this._auditWrite({ phone, cmd: '/help', ok: true });
    }

    async _cmdStatus(phone, msg) {
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
        await msg.reply(lines.join('\n'));
        this._auditWrite({ phone, cmd: '/status', ok: true });
    }

    async _cmdFiles(phone, msg) {
        if (!this.libraryService) { await msg.reply('Library service not available.'); return; }
        const items = this.libraryService.list();
        if (!items.length) { await msg.reply('No files in Library. Send a G-code file with caption "/upload".'); return; }
        const lines = ['*Library files:*'];
        items.slice(0, 20).forEach((it, i) => {
            lines.push(`${i + 1}. ${it.name} (${this._sizeStr(it.size)})`);
        });
        if (items.length > 20) lines.push(`… +${items.length - 20} more`);
        await msg.reply(lines.join('\n'));
        this._auditWrite({ phone, cmd: '/files', ok: true });
    }

    async _cmdLoad(phone, msg, name) {
        if (!this.libraryService) { await msg.reply('Library service not available.'); return; }
        const items = this.libraryService.list();
        const it = items.find((i) => i.name.toLowerCase() === name.toLowerCase()
                                  || i.fileName.toLowerCase() === name.toLowerCase());
        if (!it) { await msg.reply(`No Library file matches "${name}". Try /files.`); return; }
        const ctl = this.getController?.();
        if (!ctl) { await msg.reply('No controller connected.'); return; }
        try {
            const body = this.libraryService.getBody(it.id);
            // Feed the loaded body into the controller's sender
            if (typeof ctl.loadFile === 'function') {
                ctl.loadFile({ name: it.fileName, body, lines: it.lineCount });
            } else if (typeof ctl.sender?.load === 'function') {
                ctl.sender.load(body.split(/\r?\n/));
            }
            await msg.reply(`Loaded *${it.name}* (${it.lineCount || '?'} lines). Send /start to run.`);
            this._auditWrite({ phone, cmd: '/load', arg: name, ok: true });
        } catch (err) {
            await msg.reply(`Load failed: ${err.message}`);
            this._auditWrite({ phone, cmd: '/load', arg: name, ok: false, error: err.message });
        }
    }

    async _cmdJog(phone, msg, args) {
        const ctl = this.getController?.();
        if (!ctl) { await msg.reply('No controller connected.'); return; }
        // Parse "X+10" / "Y-5" / "Z+0.5"
        const spec = (args[0] || '').toUpperCase();
        const m = spec.match(/^([XYZ])([+-]?\d+(?:\.\d+)?)$/);
        if (!m) { await msg.reply('Usage: /jog X+10  or /jog Y-5  or /jog Z+0.5'); return; }
        const axis = m[1];
        const dist = parseFloat(m[2]);
        if (!isFinite(dist) || dist === 0) { await msg.reply('Invalid distance.'); return; }
        const feed = axis === 'Z' ? 500 : 2000;
        const gcode = `$J=G91 G21 ${axis}${dist} F${feed}`;
        try {
            ctl.command?.('jog', gcode);
            await msg.reply(`Jogging ${axis}${dist > 0 ? '+' : ''}${dist} mm…`);

            // If a bot-eye webcam is configured, snap + attach AFTER 1.5 s
            const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
            if (cfg.botEyeCameraId && this.webcamService?.snapshot) {
                await new Promise((r) => setTimeout(r, 1500));
                try {
                    const buf = this.webcamService.snapshot(cfg.botEyeCameraId);
                    if (buf && buf.length) {
                        const { MessageMedia } = require('whatsapp-web.js');
                        const media = new MessageMedia('image/jpeg', buf.toString('base64'), 'after-jog.jpg');
                        await msg.reply(media, undefined, { caption: 'After jog' });
                    }
                } catch (err) { this.log.warn?.('whatsapp.bot.snap.failed', { err: err?.message }); }
            }
            this._auditWrite({ phone, cmd: '/jog', arg: spec, ok: true });
        } catch (err) {
            await msg.reply(`Jog failed: ${err.message}`);
            this._auditWrite({ phone, cmd: '/jog', arg: spec, ok: false, error: err.message });
        }
    }

    async _cmdStop(phone, msg) {
        const ctl = this.getController?.();
        if (!ctl) { await msg.reply('No controller connected.'); return; }
        try {
            ctl.command?.('pause');
            ctl.command?.('feedhold');
            await msg.reply('⏸ Stopped. Send /start to resume from beginning, or use the host UI to resume.');
            this._auditWrite({ phone, cmd: '/stop', ok: true });
        } catch (err) {
            await msg.reply(`Stop failed: ${err.message}`);
            this._auditWrite({ phone, cmd: '/stop', ok: false, error: err.message });
        }
    }

    async _cmdHomeRun(phone) {
        const ctl = this.getController?.();
        if (!ctl) return this._notifyAll('No controller connected.');
        try {
            ctl.command?.('homing');
            await this._notifySender(phone, 'Homing all axes…');
            this._auditWrite({ phone, cmd: '/home', ok: true, stage: 'fired' });
        } catch (err) {
            await this._notifySender(phone, `Home failed: ${err.message}`);
            this._auditWrite({ phone, cmd: '/home', ok: false, error: err.message });
        }
    }

    async _cmdStartRun(phone) {
        const ctl = this.getController?.();
        if (!ctl) return this._notifyAll('No controller connected.');
        try {
            ctl.command?.('cyclestart');
            await this._notifySender(phone, '▶ Starting…');
            this._auditWrite({ phone, cmd: '/start', ok: true, stage: 'fired' });
        } catch (err) {
            await this._notifySender(phone, `Start failed: ${err.message}`);
            this._auditWrite({ phone, cmd: '/start', ok: false, error: err.message });
        }
    }

    async _cmdUpload(phone, msg) {
        if (!this.libraryService) { await msg.reply('Library service not available.'); return; }
        try {
            const media = await msg.downloadMedia();
            if (!media) { await msg.reply('Couldn\'t download the attachment.'); return; }
            const body = Buffer.from(media.data, 'base64').toString('utf-8');
            const fileName = media.filename || `bot-upload-${Date.now()}.gcode`;
            const name = fileName.replace(/\.[^.]+$/, '');
            const entry = this.libraryService.upsert({ name, fileName, body });
            await msg.reply(`✓ Saved *${entry.name}* to Library (${entry.lineCount} lines · ${this._sizeStr(entry.size)}). Send /load ${entry.name} to use it.`);
            this._auditWrite({ phone, cmd: '/upload', arg: fileName, ok: true });
        } catch (err) {
            await msg.reply(`Upload failed: ${err.message}`);
            this._auditWrite({ phone, cmd: '/upload', ok: false, error: err.message });
        }
    }

    async _cmdUploadHint(phone, msg) {
        await msg.reply('Attach a G-code file (.gcode / .nc / .tap) to your next message and add the caption */upload*.');
        this._auditWrite({ phone, cmd: '/upload', ok: true, stage: 'hint' });
    }

    // ─── helpers ───────────────────────────────────────────────────

    async _sendWelcomePing() {
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
        const recipients = Array.isArray(cfg.recipients) ? cfg.recipients : [];
        if (!recipients.length) return; // no one to greet — /ping from any sender still works
        const banner = [
            '*EasyCNC bot — online*',
            cfg.botEnabled ? 'Bot is ON. Send */help* for commands or */ping* to verify.' : 'Bot is OFF — enable it in EasyCNC → Settings → Notifications.',
        ].join('\n');
        for (const phone of recipients) {
            try { await this._notifySender(phone, banner); }
            catch (_) { /* swallow */ }
        }
        this._auditWrite({ event: 'welcome', recipients: recipients.length, botEnabled: cfg.botEnabled });
    }

    _auditWrite(entry) {
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
        try { fs.appendFileSync(this._auditLog, line); }
        catch (err) { this.log.warn?.('whatsapp.audit.write.failed', { err: err?.message }); }
        this.io?.emit?.('whatsapp:bot:log', { ts: new Date().toISOString(), ...entry });
    }

    async _notifySender(phone, text) {
        if (!this.client?.sendMessage) return;
        try { await this.client.sendMessage(this._phoneToChatId(phone), text); }
        catch (err) { this.log.error?.('whatsapp.notify.failed', { err: err?.message }); }
    }

    async _notifyAll(text) {
        const cfg = { ...DEFAULT_CONFIG, ...this._readCfg() };
        for (const phone of cfg.recipients) await this._notifySender(phone, text);
    }

    _sizeStr(n) {
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }
}

module.exports = { WhatsAppService, EVENT_KEYS };
