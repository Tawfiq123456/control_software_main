/**
 * CNCEngine - Socket.IO server for real-time frontend communication.
 *
 * Manages:
 *   - Connection lifecycle (open/close serial/network ports)
 *   - Automatic firmware detection and controller instantiation
 *   - Multi-client Socket.IO broadcasting
 *   - Port enumeration
 *   - G-code file management
 *   - Command routing to active controller
 *
 * Reference: gSender CNCEngine.js (GPLv3, Sienci Labs Inc.)
 * @see https://github.com/Sienci-Labs/gsender/blob/master/src/server/services/cncengine/CNCEngine.js
 */
const path = require('path');
const { EventEmitter } = require('events');
const { Connection, FIRMWARE_GRBL, FIRMWARE_GENERIC } = require('./Connection');
const { SerialConnection } = require('./SerialConnection');
const { createController } = require('./controllers');
const { createSessionLogger } = require('./SessionLogger');
const { ConfigStore } = require('./ConfigStore');
const { isRotaryFile } = require('../lib/rotary');
const { validateToolpath, defaultMachineLimits } = require('./SafetyValidator');
const remoteDiagMirror = require('./RemoteDiagMirror');
const logger = require('../logger');

class CNCEngine extends EventEmitter {
    /**
     * @param {object} io - Socket.IO server instance
     */
    constructor(io) {
        super();

        this.io = io;

        /** @type {Connection|null} Active connection */
        this.connection = null;

        /** @type {import('./GRBLController').GrblController|null} Active controller */
        this.controller = null;

        /** @type {string|null} Active port/path */
        this.port = null;

        /** @type {object|null} Loaded G-code file info */
        this.loadedFile = null;

        /** @type {object|null} Session logger */
        this.sessionLogger = null;

        /** @type {ConfigStore} Persistent configuration */
        this.config = new ConfigStore(
            path.join(__dirname, '..', 'data', 'config.json')
        );

        /** @type {import('./jobresume/JobResumeService').JobResumeService|null} */
        this.jobResumeService = null;

        // Track whether a job is in a paused state for file-upload conflict detection.
        this._jobPaused = false;

        // ECSS-E: bring up the remote diag mirror if the user previously
        // toggled it on. The mirror connects out; it never accepts inbound
        // connections, so this is safe to fire-and-forget on boot.
        const diagEnabled = this.config.get('preferences.remoteDiagEnabled', false);
        const diagUrl = this.config.get('preferences.remoteDiagUrl', null);
        if (diagUrl) remoteDiagMirror.setUrl(diagUrl);
        remoteDiagMirror.onInject((payload) => {
            // Inject-handler — forwards command to the active controller.
            try {
                if (this.controller && payload && payload.cmd) {
                    logger.warn(`[RemoteDiag] INJECT: ${payload.cmd} ${JSON.stringify(payload.args || [])}`);
                    this.controller.command(payload.cmd, ...(payload.args || []));
                }
            } catch (e) {
                logger.warn(`[RemoteDiag] inject failed: ${e.message}`);
            }
        });
        if (diagEnabled) {
            remoteDiagMirror.start();
        }

        this._setupSocketIO();
    }

    // ─── Socket.IO Setup ─────────────────────────────────────────────

    _setupSocketIO() {
        this.io.on('connection', (socket) => {
            logger.info(`Socket.IO client connected: ${socket.id}`);

            // Send current state to newly connected client
            this._sendInitialState(socket);

            // Register the socket with the active connection
            if (this.connection) {
                this.connection.addConnection(socket);
            }

            // ─── Port Management ─────────────────────────────────
            socket.on('list', (callback) => this._handleList(socket, callback));
            socket.on('open', (portPath, options, callback) => this._handleOpen(socket, portPath, options, callback));
            socket.on('close', (portPath, callback) => this._handleClose(socket, portPath, callback));

            // ─── Commands ────────────────────────────────────────
            socket.on('command', (portPath, cmd, ...args) => this._handleCommand(socket, portPath, cmd, ...args));
            socket.on('write', (portPath, data, context) => this._handleWrite(socket, portPath, data, context));
            socket.on('writeln', (portPath, data, context) => this._handleWriteln(socket, portPath, data, context));

            // [GENERIC MODE] Raw command passthrough — writes directly to serial port
            socket.on('command:raw', (cmd) => {
                if (this.connection && this.connection.isOpen) {
                    const data = String(cmd).endsWith('\n') ? String(cmd) : String(cmd) + '\n';
                    logger.info(`[RAW CMD] ${data.trim()}`);
                    this.connection.write(data);
                }
            });

            // ─── File Management ─────────────────────────────────
            socket.on('file:load', (data) => this._handleFileLoad(socket, data));
            socket.on('file:unload', () => this._handleFileUnload(socket));

            // ECSS-E remote diag toggle is handled in _handleCommand (frontend
            // routes everything through controller.command → 'command' event,
            // not as a separate top-level socket event). On connect we still
            // push current status so the frontend hydrates the badge state.
            socket.emit('safety:remoteDiagStatus', remoteDiagMirror.status());

            // ─── Macros ──────────────────────────────────────────
            socket.on('macro:list', (callback) => {
                const macros = this.config.getMacros();
                if (typeof callback === 'function') callback(null, macros);
                else socket.emit('macro:list', macros);
            });
            socket.on('macro:save', (macro, callback) => {
                this.config.saveMacro(macro);
                const macros = this.config.getMacros();
                this.io.emit('macro:list', macros);
                if (typeof callback === 'function') callback(null, macros);
            });
            socket.on('macro:delete', (id, callback) => {
                this.config.deleteMacro(id);
                const macros = this.config.getMacros();
                this.io.emit('macro:list', macros);
                if (typeof callback === 'function') callback(null, macros);
            });
            socket.on('macro:run', (id) => {
                const macro = this.config.getMacro(id);
                if (macro && this.controller) {
                    this.controller.command('macro:run', macro.content);
                }
            });

            // ─── Tool Library ────────────────────────────────────
            socket.on('tool:list', (callback) => {
                const tools = this.config.getTools();
                if (typeof callback === 'function') callback(null, tools);
                else socket.emit('tool:list', tools);
            });
            socket.on('tool:save', (tool, callback) => {
                this.config.saveTool(tool);
                const tools = this.config.getTools();
                this.io.emit('tool:list', tools);
                if (typeof callback === 'function') callback(null, tools);
            });
            socket.on('tool:delete', (id, callback) => {
                this.config.deleteTool(id);
                const tools = this.config.getTools();
                this.io.emit('tool:list', tools);
                if (typeof callback === 'function') callback(null, tools);
            });

            // ─── Event Triggers ──────────────────────────────────
            socket.on('trigger:list', (callback) => {
                if (this.controller) {
                    const triggers = this.controller.getEventTriggers();
                    if (typeof callback === 'function') callback(null, triggers);
                    else socket.emit('trigger:list', triggers);
                }
            });
            socket.on('trigger:set', (eventName, config) => {
                if (this.controller) {
                    this.controller.command('trigger:set', eventName, config);
                    this.config.set(`eventTriggers.${eventName}`, config);
                }
            });

            // ─── Config / Preferences ────────────────────────────
            socket.on('config:get', (key, callback) => {
                const value = this.config.get(key);
                if (typeof callback === 'function') callback(null, value);
            });
            socket.on('config:set', (key, value) => {
                this.config.set(key, value);
                this.io.emit('config:change', { key, value });
            });
            socket.on('config:getAll', (callback) => {
                if (typeof callback === 'function') callback(null, this.config.getAll());
            });

            // ─── Debug Monitor ───────────────────────────────────
            socket.on('debug:enable', () => {
                if (this.controller) this.controller.command('debug:enable');
            });
            socket.on('debug:disable', () => {
                if (this.controller) this.controller.command('debug:disable');
            });
            socket.on('debug:getEntries', (count, type, callback) => {
                if (this.controller) {
                    const entries = this.controller.debugMonitor.getEntries(count, type);
                    if (typeof callback === 'function') callback(null, entries);
                }
            });

            // ─── Health Check ────────────────────────────────────
            socket.on('hPing', () => {
                socket.emit('hPong');
                if (this.controller) {
                    this.controller.healthMonitor.recordPong();
                }
            });
            socket.on('health:metrics', (callback) => {
                if (this.controller) {
                    const metrics = this.controller.getHealthMetrics();
                    if (typeof callback === 'function') callback(null, metrics);
                    else socket.emit('health:metrics', metrics);
                }
            });

            // ─── Firmware Flashing ───────────────────────────────
            socket.on('firmware:flash', async (options, callback) => {
                const { port, boardType, hexPath } = options || {};
                try {
                    const FirmwareFlashing = require('../lib/Firmware/Flashing/firmwareflashing');
                    await FirmwareFlashing.flash(port, boardType, { hexPath, socket });
                    if (typeof callback === 'function') callback(null, { success: true });
                } catch (err) {
                    logger.error(err);
                    if (typeof callback === 'function') callback(err);
                    else socket.emit('flash:error', err.message);
                }
            });

            // ─── Job Isolation (paused-job conflict resolution) ───────
            socket.on('job:conflict:replace', () => {
                // User chose to replace the paused job with the new file.
                logger.info('[Engine] job:conflict:replace — aborting paused job');
                if (this.controller) {
                    this.controller.command('gcode:stop');
                }
                if (this.jobResumeService) {
                    this.jobResumeService.clearCheckpoint();
                }
                this._jobPaused = false;
                // The file:load that was rejected will be retried by the
                // frontend after receiving 'job:conflict:resolved'.
                this.io.emit('job:conflict:resolved', { action: 'replaced' });
            });

            socket.on('job:conflict:cancel', () => {
                // User chose to keep the paused job — reject the upload.
                logger.info('[Engine] job:conflict:cancel — keeping paused job');
                this.io.emit('job:conflict:resolved', { action: 'cancelled' });
            });

            socket.on('job:conflict:save', () => {
                // User chose to save the paused job checkpoint, then allow the new file.
                logger.info('[Engine] job:conflict:save — saving checkpoint then clearing');
                if (this.controller) {
                    this.controller.command('gcode:stop');
                }
                // Checkpoint is already saved by the stop handler via JobResumeService.
                // Don't clear it — user explicitly asked to save.
                this._jobPaused = false;
                this.io.emit('job:conflict:resolved', { action: 'saved' });
            });

            socket.on('job:resume:confirm', (opts) => {
                // User confirmed they want to resume from the checkpoint.
                if (this.jobResumeService) {
                    const result = this.jobResumeService.resumeFromCheckpoint(opts || {});
                    socket.emit('job:resume:result', result);
                } else {
                    socket.emit('job:resume:result', { ok: false, error: 'Resume service not available' });
                }
            });

            // ─── Cleanup ─────────────────────────────────────────────
            socket.on('disconnect', () => {
                logger.info(`Socket.IO client disconnected: ${socket.id}`);
                if (this.connection) {
                    this.connection.removeConnection(socket);
                }
            });
        });
    }

    // ─── Initial State ───────────────────────────────────────────────

    _sendInitialState(socket) {
        // Send current connection state
        if (this.controller && this.connection && this.connection.isOpen) {
            socket.emit('serialport:open', {
                port: this.port,
                controllerType: this.connection.controllerType,
            });

            // Send current controller state
            const controllerState = {
                status: this.controller.state?.status || {},
                parserstate: this.controller.state?.parserstate || {},
            };
            socket.emit('controller:state', this.controller.type, controllerState);

            // Send workflow state (all controllers implement this)
            if (typeof this.controller.getWorkflowState === 'function') {
                socket.emit('workflow:state', this.controller.getWorkflowState());
            }

            // Send sender status
            if (typeof this.controller.getSenderStatus === 'function') {
                socket.emit('sender:status', this.controller.getSenderStatus());
            }

            // Send feeder status
            if (typeof this.controller.getFeederStatus === 'function') {
                socket.emit('feeder:status', this.controller.getFeederStatus());
            }

            // Send tool changer status
            if (typeof this.controller.getToolChangerStatus === 'function') {
                socket.emit('toolchanger:status', this.controller.getToolChangerStatus());
            }

            // Send loaded file info
            if (this.loadedFile) {
                socket.emit('file:load', this.loadedFile);
            }
        }

        // Always send config data (macros, tools, preferences)
        socket.emit('macro:list', this.config.getMacros());
        socket.emit('tool:list', this.config.getTools());
        socket.emit('config:all', this.config.getAll());
    }

    // ─── Port Listing ────────────────────────────────────────────────

    async _handleList(socket, callback) {
        try {
            const ports = await SerialConnection.listPorts();
            const portList = ports.map((p) => ({
                port: p.path,
                manufacturer: p.manufacturer || '',
                serialNumber: p.serialNumber || '',
                vendorId: p.vendorId || '',
                productId: p.productId || '',
                inuse: this.port === p.path,
            }));

            if (typeof callback === 'function') {
                callback(null, portList);
            }
            socket.emit('serialport:list', portList);
        } catch (err) {
            logger.error('Port listing error:', err);
            if (typeof callback === 'function') {
                callback(err);
            }
        }
    }

    // ─── Open Connection ─────────────────────────────────────────────

    async _handleOpen(socket, portPath, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        options = options || {};

        if (!portPath) {
            const err = new Error('Missing port path or IP address');
            if (typeof callback === 'function') callback(err);
            return;
        }

        // Close existing connection if any
        if (this.connection && this.connection.isOpen) {
            this._closeConnection();
        }

        const baudRate = options.baudRate || 115200;
        const network = options.network || false;
        const rtscts = options.rtscts || false;

        logger.info(`Opening connection: ${portPath} (baud: ${baudRate}, network: ${network}, rtscts: ${rtscts})`);

        // Create Connection (Layer 2)
        this.connection = new Connection({
            path: portPath,
            baudRate,
            network,
            rtscts,
        });
        this.port = portPath;

        // Register the requesting socket
        this.connection.addConnection(socket);

        // Listen for firmware detection
        this.connection.on('firmwareDetected', (firmware, dataBuffer) => {
            this._onFirmwareDetected(firmware, dataBuffer);
        });

        // Listen for connection events
        this.connection.on('error', (err) => {
            logger.error(`Connection error: ${err?.message}`);
            this.io.emit('serialport:error', { port: portPath, error: err?.message });
        });

        this.connection.on('close', () => {
            this._onConnectionClose();
        });

        // Open the connection
        this.connection.open((err) => {
            if (err) {
                logger.error(`Failed to open ${portPath}: ${err.message}`);
                this.connection = null;
                this.port = null;
                if (typeof callback === 'function') callback(err);
                socket.emit('serialport:error', { port: portPath, error: err.message });
                return;
            }

            // Start session logging
            if (this.sessionLogger) {
                this.sessionLogger.close();
            }
            this.sessionLogger = createSessionLogger(logger.sessionsDir, portPath);
            this.sessionLogger.logConnection(true, portPath);

            logger.info(`Connection opened: ${portPath}`);
            this.io.emit('serialport:open', { port: portPath });

            if (typeof callback === 'function') callback(null);
        });
    }

    // ─── Firmware Detection → Controller Instantiation ───────────────

    _onFirmwareDetected(firmware, dataBuffer) {
        logger.info(`Firmware detected: ${firmware}`);

        // Create the appropriate controller
        this.controller = createController(firmware);

        // Bind controller to connection
        this.controller.bind(this.connection);

        // Wire controller events to Socket.IO
        this._wireControllerEvents();

        // Notify all clients
        this.io.emit('controller:type', firmware);

        // [GENERIC MODE] GenericController has no runner — skip replay
        // [RTS] RTSController has no runner — skip replay
        // [GRBL ONLY] Replay buffered data through the GRBL runner
        if (this.controller.runner && typeof this.controller.runner.parse === 'function' && dataBuffer && dataBuffer.length > 0) {
            for (const line of dataBuffer) {
                this.controller.runner.parse(line);
            }
        }

        // Log
        if (this.sessionLogger) {
            this.sessionLogger.logConnection(true, `Firmware: ${firmware}`);
        }
    }

    // ─── Controller Event Wiring ─────────────────────────────────────

    _wireControllerEvents() {
        if (!this.controller) return;

        // Console output
        this.controller.on('console', (line) => {
            this.io.emit('serialport:read', line);
            if (this.sessionLogger) this.sessionLogger.logConsole(line);
        });

        // Status updates
        this.controller.on('status', (status) => {
            this.io.emit('controller:state', this.controller.type, {
                status,
                parserstate: this.controller.state.parserstate,
            });
            if (this.sessionLogger) {
                const pos = status.wpos || status.mpos;
                /* job-63998 debug extension -- see RSPController.js
                 * _onTelemetry(). Only RSPController sets these; every other
                 * controller leaves them undefined and JSON.stringify drops
                 * undefined keys, so this is a no-op for GRBL/RTS sessions. */
                this.sessionLogger.logPosition({
                    ...pos,
                    last_executed_line: status.lastExecutedLine,
                    state: status.state,
                    estop_active: status.estop,
                    dbg_jog_active: status.dbgJogActive,
                    dbg_jog_done_evt: status.dbgJogDoneEvt,
                    dbg_tim2_isr_count: status.dbgTim2IsrCount,
                    dbg_steps_done: status.dbgStepsDone,
                    dbg_steps_total: status.dbgStepsTotal,
                });
            }
            // ECSS — re-validate if the WCO has changed since last run.
            const wco = status?.wco || this.controller?._wco;
            if (wco) this._maybeRevalidateOnWcoChange(wco);
        });

        // Parser state
        this.controller.on('parserstate', (ps) => {
            this.io.emit('controller:state', this.controller.type, {
                status: this.controller.state.status,
                parserstate: ps,
            });
        });

        // ECSS Module 2 — WCS health banner.
        this.controller.on('safety:wcsHealth', (payload) => {
            this.io.emit('safety:wcsHealth', payload);
            if (!payload.healthy) {
                logger.warn(`[ECSS] WCS health: ${payload.flagged.map(f => `${f.axis}=${f.value}`).join(', ')} (threshold ±${payload.threshold} mm).`);
            }
        });

        // ECSS Module 3 — Z runaway abort surfaced to UI + session log.
        this.controller.on('safety:zRunaway', (payload) => {
            this.io.emit('safety:zRunaway', payload);
            logger.error(`[ECSS] Z RUNAWAY fired: drop=${payload.drop} mm in ${payload.windowMs} ms, mposZ=${payload.mposZ}`);
            if (this.sessionLogger) {
                this.sessionLogger.logJob({ event: 'ecss-z-runaway', ...payload });
            }
        });

        // Initialization
        this.controller.on('initialized', (info) => {
            this.io.emit('controller:initialized', info);
            if (this.sessionLogger) {
                this.sessionLogger.logConnection(true, `Initialized: ${info.firmwareType} ${info.firmwareVersion}`);
            }
        });

        // Workflow state changes
        this.controller.on('workflow:state', (state) => {
            this.io.emit('workflow:state', state);
            if (this.sessionLogger) this.sessionLogger.logState(state);
        });

        // Sender status
        this.controller.on('sender:status', (status) => {
            this.io.emit('sender:status', status);
        });

        // Sender paused — track for job isolation guard
        this.controller.on('sender:pause', () => {
            this._jobPaused = true;
            this.io.emit('sender:pause');
        });

        this.controller.on('sender:start', (data) => {
            this.io.emit('sender:start', data);
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'started' });
        });

        this.controller.on('sender:end', (data) => {
            this._jobPaused = false;
            this.io.emit('sender:end', data);
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'completed', ...data });
        });

        this.controller.on('sender:error', (err) => {
            this._jobPaused = false;
            this.io.emit('sender:error', err);
            if (this.sessionLogger) this.sessionLogger.logJob({ event: 'error', ...err });
        });

        // Alarms and errors
        this.controller.on('alarm', (alarm) => {
            this.io.emit('controller:alarm', alarm);
        });

        this.controller.on('error', (err) => {
            this.io.emit('controller:error', err);
        });

        // Settings
        this.controller.on('settings', (setting) => {
            this.io.emit('controller:settings', setting);
        });

        // Feedback messages
        this.controller.on('feedback', (fb) => {
            this.io.emit('controller:feedback', fb);
        });

        // Parameters (probe results, work coordinates)
        this.controller.on('parameters', (params) => {
            this.io.emit('controller:parameters', params);
        });

        // ─── Feeder events ───────────────────────────────────
        this.controller.on('feeder:status', (status) => {
            this.io.emit('feeder:status', status);
        });

        // ─── Tool changer events ─────────────────────────────
        this.controller.on('toolchange:start', (data) => {
            this.io.emit('toolchange:start', data);
        });
        this.controller.on('toolchange:complete', (data) => {
            this.io.emit('toolchange:complete', data);
        });
        this.controller.on('toolchange:cancel', () => {
            this.io.emit('toolchange:cancel');
        });
        this.controller.on('toolchange:request', (data) => {
            this.io.emit('toolchange:request', data);
        });
        this.controller.on('toolchange:error', (data) => {
            this.io.emit('toolchange:error', data);
        });

        // ─── Event trigger events ────────────────────────────
        this.controller.on('eventtrigger:fired', (data) => {
            this.io.emit('eventtrigger:fired', data);
        });

        // ─── Debug monitor events ────────────────────────────
        this.controller.on('serial:debug:log', (entry) => {
            this.io.emit('serial:debug:log', entry);
        });

        // ─── Health monitor events ───────────────────────────
        this.controller.on('health:stale', (data) => {
            this.io.emit('health:stale', data);
        });
        this.controller.on('health:reconnect:attempt', (data) => {
            this.io.emit('health:reconnect:attempt', data);
        });
        this.controller.on('health:reconnect:success', () => {
            this.io.emit('health:reconnect:success');
        });
        this.controller.on('health:reconnect:failed', (data) => {
            this.io.emit('health:reconnect:failed', data);
        });

        // ─── Homing events ──────────────────────────────────
        this.controller.on('homing:location', (data) => {
            this.io.emit('homing:location', data);
        });
        this.controller.on('homing:limits', (data) => {
            this.io.emit('homing:limits', data);
        });
        // Per-axis progress signal — tells the overlay which axis is running now.
        this.controller.on('homing:axis', (data) => {
            this.io.emit('homing:axis', data);
        });

        // ─── Motor status events ──────────────────────────────
        this.controller.on('motor:status', (data) => {
            this.io.emit('motor:status', data);
        });

        // Close
        this.controller.on('close', () => {
            // Handled by _onConnectionClose
        });

        // Load saved event triggers into the controller
        const savedTriggers = this.config.get('eventTriggers', {});
        if (Object.keys(savedTriggers).length > 0) {
            this.controller.command('trigger:loadAll', savedTriggers);
        }
    }

    // ─── Close Connection ────────────────────────────────────────────

    _handleClose(socket, portPath, callback) {
        if (typeof portPath === 'function') {
            callback = portPath;
            portPath = this.port;
        }

        this._closeConnection();

        if (typeof callback === 'function') callback(null);
    }

    _closeConnection() {
        if (this.controller) {
            this.controller.unbind();
            this.controller.removeAllListeners();
            this.controller = null;
        }

        if (this.connection) {
            this.connection.close();
            this.connection = null;
        }

        const closedPort = this.port;
        this.port = null;

        if (this.sessionLogger) {
            this.sessionLogger.logConnection(false, 'disconnect');
            this.sessionLogger.close();
            this.sessionLogger = null;
        }

        if (closedPort) {
            this.io.emit('serialport:close', { port: closedPort });
        }
    }

    _onConnectionClose() {
        const closedPort = this.port;

        if (this.controller) {
            // Tawfiq msg11378: an OS-level USB/COM drop mid-job silently
            // killed the job with no explanation beyond a generic
            // "Disconnected" — unlike an RSP-protocol link-loss (job.js's
            // LINK_GRACE_S), the transport itself is gone here, so there's
            // nothing to retry; the least we can do is checkpoint the
            // resume point NOW (before it's lost to unbind()) and tell the
            // frontend a job was actually interrupted, not just closed.
            let lostJob = null;
            if (typeof this.controller.notifyConnectionLost === 'function') {
                try {
                    lostJob = this.controller.notifyConnectionLost();
                } catch (err) {
                    logger.warn(`notifyConnectionLost failed: ${err.message}`);
                }
            }
            if (lostJob && lostJob.jobWasActive) {
                this.io.emit('connection:lost', {
                    port: closedPort,
                    resumeLine: lostJob.resumeLine,
                });
            }
            this.controller.unbind();
            this.controller.removeAllListeners();
            this.controller = null;
        }

        this.connection = null;
        this.port = null;

        if (this.sessionLogger) {
            this.sessionLogger.logConnection(false, 'disconnect');
            this.sessionLogger.close();
            this.sessionLogger = null;
        }

        if (closedPort) {
            logger.info(`Connection closed: ${closedPort}`);
            this.io.emit('serialport:close', { port: closedPort });
        }
    }

    // ─── Command Handling ────────────────────────────────────────────

    _handleCommand(socket, portPath, cmd, ...args) {
        if (!this.controller) {
            logger.warn(`[Engine] command '${cmd}' rejected: no active controller`);
            socket.emit('serialport:error', { error: 'No active controller' });
            return;
        }

        // ECSS Module 1 — block Start when the loaded toolpath fails validation.
        // A one-shot override (set via 'safety:overrideOnce' socket command)
        // bypasses the block for the next Start and then auto-clears. Used for
        // diagnostic moves on a machine with known-bad offsets; Module 3
        // (Z runaway watchdog) still fires at the motion layer regardless.
        const startCmds = new Set(['gcode:start', 'gcode:resume', 'cyclestart', 'sender:start']);
        if (startCmds.has(cmd) && this._loadedGcodeContent) {
            this._runSafetyValidation();
        }
        if (startCmds.has(cmd) && this._lastSafetyVerdict?.blocked) {
            if (this._safetyOverrideOnce) {
                logger.warn(`[ECSS] Pre-flight BLOCK overridden by user — proceeding with ${cmd}. (Module 3 Z watchdog still active.)`);
                this._safetyOverrideOnce = false;
                this.io.emit('safety:overrideConsumed', { command: cmd });
            } else {
                const reasons = (this._lastSafetyVerdict.issues || []).slice(0, 3).map(i => i.message).join(' ');
                logger.warn(`[ECSS] Start BLOCKED by pre-flight: ${reasons}`);
                socket.emit('safety:blocked', {
                    command: cmd,
                    verdict: this._lastSafetyVerdict,
                });
                return;
            }
        }

        // Override toggle command (one-shot, allows next Start only).
        if (cmd === 'safety:overrideOnce') {
            this._safetyOverrideOnce = true;
            logger.warn('[ECSS] Pre-flight override armed — next Start will bypass validator.');
            this.io.emit('safety:overrideArmed', { armed: true });
            return;
        }

        // ECSS Commit E — Remote diagnostic mirror toggle (intercept before
        // routing to controller, otherwise RTSController treats it as an
        // unknown command and logs a warning).
        if (cmd === 'safety:remoteDiagToggle') {
            const opts = args[0] || {};
            const enable = !!opts.enabled;
            const url = typeof opts.url === 'string' ? opts.url : null;
            if (url) remoteDiagMirror.setUrl(url);
            if (enable) {
                remoteDiagMirror.start();
            } else {
                remoteDiagMirror.stop();
            }
            try {
                this.config.set('preferences.remoteDiagEnabled', enable);
                if (url) this.config.set('preferences.remoteDiagUrl', url);
            } catch (_) {}
            this.io.emit('safety:remoteDiagStatus', remoteDiagMirror.status());
            return;
        }
        if (cmd === 'safety:remoteDiagStatus') {
            socket.emit('safety:remoteDiagStatus', remoteDiagMirror.status());
            return;
        }

        if (cmd && (cmd.startsWith('gcode:') || cmd === 'feedhold' || cmd === 'cyclestart')) {
            logger.info(`[Engine] command: ${cmd}${args.length ? ' ' + JSON.stringify(args) : ''}`);
        }

        try {
            this.controller.command(cmd, ...args);
        } catch (err) {
            logger.error(`[Engine] command '${cmd}' threw: ${err.message}`);
            socket.emit('serialport:error', { error: err.message });
        }
    }

    _handleWrite(socket, portPath, data, context) {
        if (!this.controller) return;
        this.controller.write(data, context);
    }

    _handleWriteln(socket, portPath, data, context) {
        if (!this.controller) return;
        this.controller.writeln(data, context);
    }

    // ─── File Management ─────────────────────────────────────────────

    _handleFileLoad(socket, data) {
        if (!this.controller) {
            logger.warn('[Engine] file:load rejected: no active controller');
            socket.emit('serialport:error', { error: 'No active controller' });
            return;
        }

        const { name, content, gcode } = data || {};
        const gcodeContent = content || gcode;

        if (!gcodeContent) {
            logger.warn('[Engine] file:load rejected: missing content');
            socket.emit('serialport:error', { error: 'Missing G-code content' });
            return;
        }

        const fileName = name || 'untitled.gcode';
        logger.info(`[Engine] file:load received: name="${fileName}" bytes=${gcodeContent.length}`);

        // ─── Job Isolation Guard ─────────────────────────────────────
        // If a job is currently paused, don't silently overwrite the loaded
        // G-code. Emit a conflict event so the frontend can show a modal
        // asking the user what to do (replace / cancel / save & replace).
        if (this._jobPaused) {
            const senderStatus = (typeof this.controller?.getSenderStatus === 'function')
                ? this.controller.getSenderStatus() : null;
            const pausedInfo = {
                filename: this.loadedFile?.name || 'unknown',
                resumeLine: senderStatus?.received || 0,
                totalLines: senderStatus?.total || 0,
                newFilename: fileName,
            };
            logger.warn(`[Engine] file:load blocked — job is paused: ${JSON.stringify(pausedInfo)}`);
            socket.emit('job:conflict', pausedInfo);
            // Store the pending upload so it can be retried after conflict resolution.
            this._pendingUpload = { name: fileName, content: gcodeContent };
            return;
        }

        // Load into controller's sender
        this.controller.command('gcode:load', fileName, gcodeContent);

        // Store file info for reconnecting clients
        const senderTotal = this.controller.sender?.total || gcodeContent.split('\n').filter(l => l.trim()).length;
        this.loadedFile = {
            name: fileName,
            total: senderTotal,
            size: gcodeContent.length,
            isRotary: isRotaryFile(gcodeContent),
        };

        this.io.emit('file:load', this.loadedFile);

        // ECSS Module 1 — toolpath is stored for validation, but the check
        // itself no longer runs here. It used to fire immediately on every
        // upload (_runSafetyValidation() below), which meant its
        // '[ECSS] Pre-flight PASS' banner/log popped for every file the
        // instant it loaded, before Start was ever pressed and often before
        // the machine had even been homed (Tawfiq msg11358 item 6: "a
        // caution message which is useless ... shows even when the carve
        // is not started"). It now runs once, on demand, right at the
        // Start-attempt gate in _handleCommand() below -- see the
        // `this._runSafetyValidation();` call there.
        this._loadedGcodeContent = gcodeContent;

        if (this.sessionLogger) {
            this.sessionLogger.logJob({ event: 'loaded', name: fileName, total: senderTotal });
        }
    }

    /**
     * ECSS Module 1 — runs every time the loaded G-code, the active WCS, or
     * the selected machine profile changes. Emits `safety:validation` with the
     * verdict so the frontend can enable/disable Start and surface the reason.
     */
    _runSafetyValidation() {
        if (!this._loadedGcodeContent) return;
        const ctrl = this.controller;
        if (!ctrl) return;

        const wco = (typeof ctrl.getWorkOffset === 'function')
            ? ctrl.getWorkOffset()
            : (ctrl._wco || { x: 0, y: 0, z: 0 });

        const profile = this._activeMachineProfile ||
            (this.config?.get?.('machineProfiles') || []).find(p => p?.id === this.config?.get?.('activeMachineProfile'));
        const machineLimits = defaultMachineLimits(profile);

        try {
            const verdict = validateToolpath({
                gcode: this._loadedGcodeContent,
                wco,
                machineLimits,
            });
            this._lastSafetyVerdict = verdict;
            this.io.emit('safety:validation', verdict);
            if (verdict.blocked) {
                logger.warn(`[ECSS] Pre-flight BLOCKED — ${verdict.issues.length} issue(s). probableCorruptWCS=${verdict.probableCorruptWCS}`);
                verdict.issues.forEach(i => logger.warn(`[ECSS]   ${i.message}`));
            } else {
                logger.info('[ECSS] Pre-flight PASS — toolpath fits machine envelope.');
            }
        } catch (err) {
            logger.error(`[ECSS] validator threw: ${err.message}`);
        }
    }

    _handleFileUnload(socket) {
        if (this.controller) {
            this.controller.command('gcode:unload');
        }
        this.loadedFile = null;
        this._loadedGcodeContent = null;
        this._lastSafetyVerdict = null;
        this._lastValidatedWco = null;
        this.io.emit('file:unload');
        this.io.emit('safety:validation', { blocked: false, issues: [], cleared: true });
    }

    _maybeRevalidateOnWcoChange(wco) {
        if (!this._loadedGcodeContent) return;
        const last = this._lastValidatedWco;
        if (last
            && Math.abs((last.x || 0) - (wco.x || 0)) < 0.01
            && Math.abs((last.y || 0) - (wco.y || 0)) < 0.01
            && Math.abs((last.z || 0) - (wco.z || 0)) < 0.01) {
            return;
        }
        this._lastValidatedWco = { x: wco.x, y: wco.y, z: wco.z };
        this._runSafetyValidation();
    }

    // ─── Public API ──────────────────────────────────────────────────

    /**
     * Get current engine state for REST API.
     */
    getState() {
        const ctrl = this.controller;
        return {
            connected: this.connection != null && this.connection.isOpen,
            port: this.port,
            controllerType: this.connection?.controllerType || null,
            machineState: (typeof ctrl?.getMappedState === 'function') ? ctrl.getMappedState() : 'idle',
            activeState: (typeof ctrl?.getState === 'function') ? ctrl.getState() : 'Idle',
            position: (typeof ctrl?.getPosition === 'function') ? ctrl.getPosition() : { x: 0, y: 0, z: 0 },
            machinePosition: (typeof ctrl?.getMachinePosition === 'function') ? ctrl.getMachinePosition() : { x: 0, y: 0, z: 0 },
            workflowState: (typeof ctrl?.getWorkflowState === 'function') ? ctrl.getWorkflowState() : 'idle',
            senderStatus: (typeof ctrl?.getSenderStatus === 'function') ? ctrl.getSenderStatus() : null,
            feederStatus: (typeof ctrl?.getFeederStatus === 'function') ? ctrl.getFeederStatus() : null,
            overrides: (typeof ctrl?.getOverrides === 'function') ? ctrl.getOverrides() : { feed: 100, rapid: 100, spindle: 100 },
            toolChanger: (typeof ctrl?.getToolChangerStatus === 'function') ? ctrl.getToolChangerStatus() : null,
            health: (typeof ctrl?.getHealthMetrics === 'function') ? ctrl.getHealthMetrics() : null,
            loadedFile: this.loadedFile,
        };
    }

    /**
     * List available serial ports.
     */
    async listPorts() {
        return SerialConnection.listPorts();
    }
}

module.exports = { CNCEngine };
