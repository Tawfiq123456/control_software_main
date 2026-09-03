/**
 * GrblController - Full GRBL controller with Runner, Sender, Feeder,
 * Workflow, ToolChanger, EventTrigger, DebugMonitor, and HealthMonitor.
 *
 * Orchestrates:
 *   - GrblRunner: parses all serial responses, maintains machine state
 *   - Sender: streams G-code files with character-counting flow control
 *   - Feeder: command queue for manual/interactive commands
 *   - Workflow: job execution state machine
 *   - ToolChanger: M6 tool change workflow
 *   - EventTrigger: custom G-code hooks on program events
 *   - SerialDebugMonitor: TX/RX/UI/Error logging
 *   - HealthMonitor: connection health and auto-reconnect
 *   - Connection: serial/network I/O
 *
 * Provides high-level commands: jog, home, unlock, probe, overrides,
 * macros, tool changes, homing helpers, and more.
 * Emits events for CNCEngine to broadcast to Socket.IO clients.
 *
 * Reference: gSender GrblController.js (GPLv3, Sienci Labs Inc.)
 */
const { EventEmitter } = require('events');
const { GrblRunner } = require('./controllers/GrblRunner');
const { Sender, SP_TYPE_CHAR_COUNTING, SP_TYPE_SEND_RESPONSE } = require('./Sender');
const { Feeder } = require('./Feeder');
const { Workflow } = require('./Workflow');
const { ToolChanger } = require('./ToolChanger');
const { EventTrigger } = require('./EventTrigger');
const { SerialDebugMonitor } = require('./SerialDebugMonitor');
const { HealthMonitor } = require('./HealthMonitor');
const {
    getSafeJogLimits,
    getHomingLocation,
} = require('./Homing');
const translateExpression = require('../lib/translate-expression');
const ensurePositiveNumber = require('../lib/ensure-positive-number');
const {
    GRBL_REALTIME_COMMANDS,
    WORKFLOW_STATE_IDLE,
    WORKFLOW_STATE_RUNNING,
    WORKFLOW_STATE_PAUSED,
    GRBL_ACTIVE_STATE_ALARM,
    GRBL_ACTIVE_STATE_IDLE,
    GRBL_ACTIVE_STATE_HOLD,
    GRBL_ACTIVE_STATE_RUN,
} = require('./controllers/constants');

const STATUS_POLL_INTERVAL = 250;
const GRBL_RX_BUFFER_SIZE = 128;
const SENDER_BUFFER_SIZE = GRBL_RX_BUFFER_SIZE - 28; // Reserve space for realtime commands

class GrblController extends EventEmitter {
    /**
     * @param {string} [type='Grbl'] - Controller type identifier
     */
    constructor(type = 'Grbl') {
        super();

        this.type = type;

        /** @type {import('./Connection').Connection|null} */
        this.connection = null;

        /** @type {GrblRunner} Response parser and state tracker */
        this.runner = new GrblRunner();

        /** @type {Sender} G-code streaming engine */
        this.sender = new Sender(SP_TYPE_CHAR_COUNTING, { bufferSize: SENDER_BUFFER_SIZE });

        /** @type {Feeder} Command queue for manual commands */
        this.feeder = new Feeder();

        /** @type {Workflow} Job execution state machine */
        this.workflow = new Workflow();

        /** @type {ToolChanger} Tool change workflow manager */
        this.toolChanger = new ToolChanger();

        /** @type {EventTrigger} Program event hooks */
        this.eventTrigger = new EventTrigger();

        /** @type {SerialDebugMonitor} Serial communication logger */
        this.debugMonitor = new SerialDebugMonitor();

        /** @type {HealthMonitor} Connection health checker */
        this.healthMonitor = new HealthMonitor();

        /** @type {object} Controller state snapshot for clients */
        this.state = {
            status: {},
            parserstate: {},
        };

        // Status polling timer
        this._queryTimer = null;

        // Initialization state
        this._initialized = false;
        this._initTimeout = null;

        // Wire up all sub-system events
        this._setupRunnerEvents();
        this._setupSenderEvents();
        this._setupFeederEvents();
        this._setupWorkflowEvents();
        this._setupToolChangerEvents();
        this._setupEventTriggerEvents();
        this._setupDebugMonitorEvents();
        this._setupHealthMonitorEvents();
    }

    // ─── Connection Binding ──────────────────────────────────────────

    /**
     * Bind this controller to a Connection instance.
     * @param {import('./Connection').Connection} connection
     */
    bind(connection) {
        this.connection = connection;
        this._initialized = false;

        // Listen for data from the connection
        this.connection.on('data', (line) => this._onData(line));
        this.connection.on('close', () => this._onClose());
        this.connection.on('error', (err) => this.emit('error', err));

        // Configure sub-systems that need connection context
        this.toolChanger.setStateProvider(() => this.getState());
        this.eventTrigger.setSendFunction((cmds) => this.command('gcode', cmds));

        // Start health monitoring
        this.healthMonitor.start();

        // Start initialization
        this._startInitialization();
    }

    /**
     * Unbind from the current connection.
     */
    unbind() {
        this._stopQueryTimer();
        this._clearInitTimeout();

        if (this.connection) {
            this.connection.removeAllListeners('data');
            this.connection.removeAllListeners('close');
            this.connection.removeAllListeners('error');
        }

        this.connection = null;
        this._initialized = false;
        this.workflow.stop();
        this.sender.rewind();
        this.feeder.reset();
        this.toolChanger.cancel();
        this.healthMonitor.stop();
    }

    // ─── Initialization ──────────────────────────────────────────────

    _startInitialization() {
        this._initialized = false;

        // Send soft reset to trigger startup message
        this.writeImmediate(GRBL_REALTIME_COMMANDS.SOFT_RESET);

        // Request initialization data after a delay
        this._initTimeout = setTimeout(() => {
            this._requestInitData();
        }, 500);
    }

    _requestInitData() {
        if (this._initialized) return;

        // Send init commands in sequence
        setTimeout(() => this.writeln('$I'), 100);   // Build info
        setTimeout(() => this.writeln('$$'), 200);   // Settings
        setTimeout(() => this.writeln('$#'), 300);   // Work coordinates
        setTimeout(() => this.writeln('$N'), 400);   // Startup lines
        setTimeout(() => this.writeln('$G'), 500);   // Parser state

        // Mark initialized and start polling after all commands sent
        this._initTimeout = setTimeout(() => {
            this._initialized = true;
            this._startQueryTimer();
            this.emit('initialized', {
                firmwareType: this.type,
                firmwareVersion: this.runner.settings.version,
            });
        }, 1000);
    }

    _clearInitTimeout() {
        if (this._initTimeout) {
            clearTimeout(this._initTimeout);
            this._initTimeout = null;
        }
    }

    // ─── Data Handling ───────────────────────────────────────────────

    _onData(line) {
        // Emit raw console output
        this.emit('console', line);

        // Debug monitor: log incoming data
        this.debugMonitor.logRx(line);

        // Health monitor: record activity
        this.healthMonitor.recordStatus();

        // Feed to runner for parsing
        this.runner.parse(line);
    }

    _onClose() {
        this._stopQueryTimer();
        this._clearInitTimeout();
        this._initialized = false;
        this.workflow.stop();
        this.sender.rewind();
        this.feeder.reset();
        this.healthMonitor.stop();
        this.emit('close');
    }

    // ─── Runner Event Wiring ─────────────────────────────────────────

    _setupRunnerEvents() {
        this.runner.on('status', (status) => {
            this.state.status = status;
            this.emit('status', status);

            // Update sender buffer size from Bf field if available
            if (status.buf && status.buf.rx > 0) {
                const newBufSize = status.buf.rx;
                if (newBufSize !== this.sender.bufferSize) {
                    this.sender.bufferSize = Math.max(newBufSize - 28, 50);
                }
            }
        });

        this.runner.on('ok', () => {
            this.emit('ok');

            // Drive the sender forward if streaming
            if (this.sender.isActive) {
                this.sender.ack();
                this.sender.next({ isOk: true });
            }
            // Drive the feeder forward if it has outstanding commands
            else if (this.feeder.hasOutstanding()) {
                this.feeder.ack();
                this.feeder.next();
            }
        });

        this.runner.on('error', (err) => {
            this.emit('error', err);

            // Acknowledge the error in sender (it consumed a buffer slot)
            if (this.sender.isActive) {
                this.sender.ack();

                // Stop on error during streaming
                if (this.workflow.isRunning()) {
                    this.workflow.stop();
                    this.sender.rewind();
                    this.emit('sender:error', err);
                }
            }
            // Acknowledge in feeder too
            else if (this.feeder.hasOutstanding()) {
                this.feeder.ack();
            }
        });

        this.runner.on('alarm', (alarm) => {
            this.emit('alarm', alarm);

            // Stop streaming on alarm
            if (!this.workflow.isIdle()) {
                this.workflow.stop();
                this.sender.rewind();
                this.feeder.clear();
            }
        });

        this.runner.on('parserstate', (ps) => {
            this.state.parserstate = ps;
            this.emit('parserstate', ps);
        });

        this.runner.on('parameters', (params) => {
            this.emit('parameters', params);
        });

        this.runner.on('feedback', (fb) => {
            this.emit('feedback', fb);
        });

        this.runner.on('settings', (setting) => {
            this.emit('settings', setting);
        });

        this.runner.on('startup', (info) => {
            // Handle startup message during initialization
            if (!this._initialized) {
                this._clearInitTimeout();
                this._requestInitData();
            }
            this.emit('startup', info);
        });

        this.runner.on('others', (data) => {
            this.emit('others', data);
        });
    }

    // ─── Sender Event Wiring ─────────────────────────────────────────

    _setupSenderEvents() {
        this.sender.on('data', (line) => {
            if (this.connection) {
                // Check for tool change (M6) before sending
                const tc = ToolChanger.parseToolChange(line);
                if (tc.hasTool) {
                    this.sender.holdStreaming('toolchange');
                    this.toolChanger.request(tc.toolNumber);
                    this.eventTrigger.fire('onToolChange');
                    return;
                }

                this.connection.writeln(line);
                this.debugMonitor.logTx(line, { source: 'sender' });
            }
        });

        this.sender.on('start', (data) => {
            this.eventTrigger.fire('onStart');
            this.emit('sender:start', data);
        });

        this.sender.on('end', (data) => {
            this.workflow.stop();
            this.eventTrigger.fire('onStop');
            this.emit('sender:end', data);
        });

        this.sender.on('change', () => {
            this.emit('sender:status', this.sender.getStatus());
        });

        this.sender.on('hold', (data) => {
            this.emit('sender:hold', data);
        });

        this.sender.on('unhold', () => {
            this.emit('sender:unhold');
        });
    }

    // ─── Feeder Event Wiring ─────────────────────────────────────────

    _setupFeederEvents() {
        this.feeder.on('data', (line, context) => {
            if (this.connection) {
                this.connection.writeln(line);
                this.debugMonitor.logTx(line, {
                    source: 'feeder',
                    ...context,
                });
            }
        });

        this.feeder.on('hold', (data) => {
            this.emit('feeder:hold', data);
        });

        this.feeder.on('unhold', () => {
            this.emit('feeder:unhold');
        });

        this.feeder.on('change', () => {
            this.emit('feeder:status', this.feeder.getStatus());
        });
    }

    // ─── Workflow Event Wiring ────────────────────────────────────────

    _setupWorkflowEvents() {
        this.workflow.on('state', (newState, prevState) => {
            this.emit('workflow:state', newState);

            // Hold feeder during job execution
            if (newState === WORKFLOW_STATE_RUNNING) {
                this.feeder.holdFeeding('workflow');
            } else if (newState === WORKFLOW_STATE_IDLE) {
                this.feeder.unhold();
            }
        });
    }

    // ─── ToolChanger Event Wiring ─────────────────────────────────────

    _setupToolChangerEvents() {
        this.toolChanger.on('toolchange:start', (data) => {
            this.emit('toolchange:start', data);
        });

        this.toolChanger.on('toolchange:complete', (data) => {
            this.emit('toolchange:complete', data);
            // Resume sender after tool change
            this.sender.unhold();
            this.writeImmediate(GRBL_REALTIME_COMMANDS.CYCLE_START);
            this.sender.next();
        });

        this.toolChanger.on('toolchange:cancel', () => {
            this.emit('toolchange:cancel');
        });

        this.toolChanger.on('toolchange:error', (data) => {
            this.emit('toolchange:error', data);
        });

        this.toolChanger.on('toolchange:request', (data) => {
            this.emit('toolchange:request', data);
        });
    }

    // ─── EventTrigger Event Wiring ────────────────────────────────────

    _setupEventTriggerEvents() {
        this.eventTrigger.on('trigger', (data) => {
            this.emit('eventtrigger:fired', data);
        });
    }

    // ─── DebugMonitor Event Wiring ────────────────────────────────────

    _setupDebugMonitorEvents() {
        this.debugMonitor.on('log', (entry) => {
            this.emit('serial:debug:log', entry);
        });
    }

    // ─── HealthMonitor Event Wiring ───────────────────────────────────

    _setupHealthMonitorEvents() {
        this.healthMonitor.on('stale', (data) => {
            this.emit('health:stale', data);
        });

        this.healthMonitor.on('reconnect:attempt', (data) => {
            this.emit('health:reconnect:attempt', data);
        });

        this.healthMonitor.on('reconnect:success', () => {
            this.emit('health:reconnect:success');
        });

        this.healthMonitor.on('reconnect:failed', (data) => {
            this.emit('health:reconnect:failed', data);
        });
    }

    // ─── Status Polling ──────────────────────────────────────────────

    _startQueryTimer() {
        this._stopQueryTimer();
        this._queryTimer = setInterval(() => {
            if (this.connection && this.connection.isOpen) {
                this.writeImmediate(GRBL_REALTIME_COMMANDS.STATUS_REPORT);
            }
        }, STATUS_POLL_INTERVAL);
    }

    _stopQueryTimer() {
        if (this._queryTimer) {
            clearInterval(this._queryTimer);
            this._queryTimer = null;
        }
    }

    // ─── Write Methods ───────────────────────────────────────────────

    /**
     * Write a line to the controller (with newline handling).
     * @param {string} data
     * @param {object} [context]
     */
    writeln(data, context) {
        if (!this.connection) return;
        this.debugMonitor.logTx(data, { source: 'direct', ...context });
        this.connection.writeln(data, context);
    }

    /**
     * Write raw data (with write filter).
     * @param {string|Buffer} data
     * @param {object} [context]
     */
    write(data, context) {
        if (!this.connection) return;
        this.debugMonitor.logTx(String(data), { source: 'direct', ...context });
        this.connection.write(data, context);
    }

    /**
     * Write immediately, bypassing write filter.
     * For realtime commands.
     * @param {string|Buffer} data
     */
    writeImmediate(data) {
        if (!this.connection) return;
        this.connection.writeImmediate(data);
    }

    /**
     * Feed a command through the Feeder queue (for manual/interactive commands).
     * @param {string} data - Command(s) to queue
     * @param {object} [context] - Metadata
     */
    feedCommand(data, context) {
        this.feeder.feed(data, context);
        this.feeder.next();
    }

    // ─── High-Level Commands ─────────────────────────────────────────

    /**
     * Execute a named controller command.
     * @param {string} cmd - Command name
     * @param {...*} args - Command arguments
     */
    command(cmd, ...args) {
        const handler = this._commands[cmd];
        if (handler) {
            handler.apply(this, args);
        } else {
            this.emit('error', { message: `Unknown command: ${cmd}` });
        }
    }

    /** Command map */
    get _commands() {
        return {
            // ─── G-code streaming ────────────────────────────────
            'gcode:load': (name, gcode, context) => {
                this.sender.load(name, gcode, context);
                this.emit('gcode:load', { name, total: this.sender.total });
            },
            'gcode:unload': () => {
                this.sender.unload();
                this.workflow.stop();
                this.emit('gcode:unload');
            },
            'gcode:start': () => {
                if (this.sender.total === 0) return;
                this.workflow.start();
                this.sender.rewind();
                this.sender.unhold();
                this.sender.next();
            },
            'gcode:startFromLine': (lineNumber) => {
                if (this.sender.total === 0) return;
                this.workflow.start();
                this.sender.rewind();
                this.sender.sent = Math.max(0, Math.min(lineNumber || 0, this.sender.total));
                this.sender.received = this.sender.sent;
                this.sender.unhold();
                this.sender.next();
            },
            'gcode:pause': () => {
                if (!this.workflow.isRunning()) return;
                this.workflow.pause();
                this.sender.holdStreaming('user');
                this.writeImmediate(GRBL_REALTIME_COMMANDS.FEED_HOLD);
                this.eventTrigger.fire('onPause');
            },
            'gcode:resume': () => {
                if (!this.workflow.isPaused()) return;
                this.workflow.resume();
                this.sender.unhold();
                this.writeImmediate(GRBL_REALTIME_COMMANDS.CYCLE_START);
                this.sender.next();
                this.eventTrigger.fire('onResume');
            },
            'gcode:stop': () => {
                this.workflow.stop();
                this.sender.rewind();
                this.feeder.clear();
                this.writeImmediate(GRBL_REALTIME_COMMANDS.FEED_HOLD);
                setTimeout(() => {
                    this.writeImmediate(GRBL_REALTIME_COMMANDS.SOFT_RESET);
                }, 250);
            },

            // ─── Feeder (manual command queue) ───────────────────
            'feeder:feed': (data, context) => {
                this.feedCommand(data, context);
            },
            'feeder:clear': () => {
                this.feeder.clear();
            },
            'feeder:hold': () => {
                this.feeder.holdFeeding('user');
            },
            'feeder:unhold': () => {
                this.feeder.unhold();
                this.feeder.next();
            },

            // ─── Realtime commands ───────────────────────────────
            'feedhold': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.FEED_HOLD),
            'cyclestart': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.CYCLE_START),
            'statusreport': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.STATUS_REPORT),
            'reset': () => {
                this.writeImmediate(GRBL_REALTIME_COMMANDS.SOFT_RESET);
                this.workflow.stop();
                this.sender.rewind();
                this.feeder.clear();
            },
            'jogcancel': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.JOG_CANCEL),

            // ─── Feed overrides ──────────────────────────────────
            'feedOverride:reset': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.FEED_OVR_RESET),
            'feedOverride:coarsePlus': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.FEED_OVR_COARSE_PLUS),
            'feedOverride:coarseMinus': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.FEED_OVR_COARSE_MINUS),
            'feedOverride:finePlus': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.FEED_OVR_FINE_PLUS),
            'feedOverride:fineMinus': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.FEED_OVR_FINE_MINUS),

            // ─── Rapid overrides ─────────────────────────────────
            'rapidOverride:reset': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.RAPID_OVR_RESET),
            'rapidOverride:medium': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.RAPID_OVR_MEDIUM),
            'rapidOverride:low': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.RAPID_OVR_LOW),

            // ─── Spindle overrides ───────────────────────────────
            'spindleOverride:reset': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.SPINDLE_OVR_RESET),
            'spindleOverride:coarsePlus': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.SPINDLE_OVR_COARSE_PLUS),
            'spindleOverride:coarseMinus': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.SPINDLE_OVR_COARSE_MINUS),
            'spindleOverride:finePlus': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.SPINDLE_OVR_FINE_PLUS),
            'spindleOverride:fineMinus': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.SPINDLE_OVR_FINE_MINUS),
            'spindleOverride:stop': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.SPINDLE_OVR_STOP),

            // ─── Coolant ─────────────────────────────────────────
            'coolant:flood': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.COOLANT_FLOOD_TOGGLE),
            'coolant:mist': () => this.writeImmediate(GRBL_REALTIME_COMMANDS.COOLANT_MIST_TOGGLE),

            // ─── Standard GRBL commands ──────────────────────────
            'homing': () => {
                // RTS-2 binary protocol — `$H` is ignored by RTS-2 firmware (proven
                // by Wireshark capture allhoming.pcapng). The vendor sender uses:
                //   1. WRITE_REG 0x03 = 1 per axis  → enables hardware limit-switch ISR
                //      monitoring per axis. Without this, motors free-run through switches.
                //   2. HOMING_INIT opcode 0x09       → tells firmware to start home cycle.
                //   3. UNLOCK 0x81 with arg 0x58     → releases alarm state.
                // After this, the board autonomously homes Z → X → Y → A, reporting
                // HOMING_PHASE_COMPLETE (0xA1) at each switch hit.
                for (let axis = 0; axis < 4; axis++) {
                    const buf = Buffer.from([
                        0x01, 0x0B, 0x00, 0x82,    // SOF, len=11, padding, WRITE_REG
                        0x03, axis,                 // register 0x03, axis sub-index
                        0x01, 0x00, 0x00, 0x00,     // value = 1 (enable limit-ISR)
                        0xFF                        // EOF
                    ]);
                    this.write(buf, { source: 'rts2-homing-enable', axis });
                }
                setTimeout(() => {
                    this.write(Buffer.from([0x01, 0x05, 0x00, 0x09, 0xFF]),
                               { source: 'rts2-homing-init' });
                }, 100);
                setTimeout(() => {
                    this.write(Buffer.from([0x01, 0x06, 0x00, 0x81, 0x58, 0xFF]),
                               { source: 'rts2-unlock' });
                }, 200);
            },
            'unlock': () => this.writeln('$X'),
            'checkmode': () => this.writeln('$C'),
            'sleep': () => this.writeln('$SLP'),
            'settings': () => this.writeln('$$'),
            'buildinfo': () => this.writeln('$I'),
            'parserstate': () => this.writeln('$G'),
            'workcoordinates': () => this.writeln('$#'),
            'startuplines': () => this.writeln('$N'),
            'help': () => this.writeln('$'),

            // ─── Jogging ─────────────────────────────────────────
            'jog': (params) => {
                const { x, y, z, a, feedRate = 1000, units = 'G21', mode = 'G91' } = params || {};
                let cmd = `$J=${mode} ${units}`;
                if (x !== undefined && x !== 0) cmd += ` X${x}`;
                if (y !== undefined && y !== 0) cmd += ` Y${y}`;
                if (z !== undefined && z !== 0) cmd += ` Z${z}`;
                if (a !== undefined && a !== 0) cmd += ` A${a}`;
                cmd += ` F${feedRate}`;
                this.writeln(cmd);
            },
            'jog:safe': (params) => {
                // Jog with safe movement limits
                const settings = this.runner.settings.settings;
                const mpos = this.runner.getMachinePosition();
                const limits = getSafeJogLimits(mpos, settings);
                const { x, y, z, feedRate = 1000, units = 'G21', mode = 'G91' } = params || {};

                let safeX = x || 0;
                let safeY = y || 0;
                let safeZ = z || 0;

                if (safeX > 0) safeX = Math.min(safeX, limits.x.max);
                if (safeX < 0) safeX = Math.max(safeX, limits.x.min);
                if (safeY > 0) safeY = Math.min(safeY, limits.y.max);
                if (safeY < 0) safeY = Math.max(safeY, limits.y.min);
                if (safeZ > 0) safeZ = Math.min(safeZ, limits.z.max);
                if (safeZ < 0) safeZ = Math.max(safeZ, limits.z.min);

                this.command('jog', { x: safeX, y: safeY, z: safeZ, feedRate, units, mode });
            },

            // ─── Tool change ─────────────────────────────────────
            'toolchange:confirm': () => {
                this.toolChanger.confirm();
            },
            'toolchange:cancel': () => {
                this.toolChanger.cancel();
                this.command('gcode:stop');
            },

            // ─── Probing ─────────────────────────────────────────
            'probe:z': (params) => {
                const { depth = -10, feedRate = 100, retract = 2 } = params || {};
                const cmds = [
                    `G38.2 Z${depth} F${feedRate}`,
                    `G91 G0 Z${retract}`,
                    'G90',
                ];
                for (const cmd of cmds) {
                    this.feedCommand(cmd, { source: 'probe' });
                }
            },
            'probe:xyz': (params) => {
                const { zDepth = -10, xyDistance = 20, feedRate = 100 } = params || {};
                this.feedCommand(`G38.2 Z${zDepth} F${feedRate}`, { source: 'probe' });
            },

            // ─── Work Coordinate Systems ─────────────────────────
            'wcs:set': (wcs) => {
                const valid = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];
                if (valid.includes(wcs)) {
                    this.writeln(wcs);
                }
            },
            'wcs:zero': (params) => {
                const { axes = ['x', 'y', 'z'], wcs = 'G54' } = params || {};
                const wcsNum = { G54: 1, G55: 2, G56: 3, G57: 4, G58: 5, G59: 6 };
                const p = wcsNum[wcs] || 1;
                let cmd = `G10 L20 P${p}`;
                for (const axis of axes) {
                    cmd += ` ${axis.toUpperCase()}0`;
                }
                this.writeln(cmd);
            },
            'wcs:zeroAll': () => {
                this.writeln('G10 L20 P1 X0 Y0 Z0');
            },

            // ─── Macro execution (with expression evaluation) ────
            'macro:run': (content) => {
                if (typeof content === 'string' && content.trim()) {
                    // Build macro context from current machine state
                    const wpos = this.runner.getWorkPosition();
                    const mpos = this.runner.getMachinePosition();
                    const macroContext = {
                        posx: wpos.x, posy: wpos.y, posz: wpos.z,
                        mposx: mpos.x, mposy: mpos.y, mposz: mpos.z,
                        x: wpos.x, y: wpos.y, z: wpos.z,
                        tool: this.runner.state.parserstate.tool || 0,
                        feedrate: this.runner.state.status.feedrate || 0,
                        spindle: this.runner.state.status.spindle || 0,
                        wcs: this.runner.state.parserstate.modal?.wcs || 'G54',
                    };

                    const lines = content.split('\n');
                    for (const rawLine of lines) {
                        const trimmed = rawLine.trim();
                        if (!trimmed || trimmed.startsWith(';')) continue;

                        // Translate [expression] patterns
                        const translated = translateExpression(trimmed, macroContext);
                        if (translated.trim()) {
                            this.feedCommand(translated, { source: 'macro' });
                        }
                    }
                }
            },

            // ─── Debug monitor ───────────────────────────────────
            'debug:enable': () => this.debugMonitor.setEnabled(true),
            'debug:disable': () => this.debugMonitor.setEnabled(false),
            'debug:clear': () => this.debugMonitor.clear(),
            'debug:logUI': (action, command) => {
                this.debugMonitor.logUI(action, command);
            },

            // ─── Event triggers ──────────────────────────────────
            'trigger:set': (eventName, config) => {
                this.eventTrigger.set(eventName, config);
            },
            'trigger:loadAll': (triggers) => {
                this.eventTrigger.loadAll(triggers);
            },

            // ─── Homing helpers ──────────────────────────────────
            'homing:location': () => {
                const setting23 = this.runner.getSetting(23) || 0;
                const location = getHomingLocation(setting23);
                this.emit('homing:location', { location, setting: setting23 });
            },
            'homing:limits': () => {
                const settings = this.runner.settings.settings;
                const mpos = this.runner.getMachinePosition();
                const limits = getSafeJogLimits(mpos, settings);
                this.emit('homing:limits', limits);
            },

            // ─── Direct G-code ───────────────────────────────────
            'gcode': (code) => {
                if (typeof code === 'string') {
                    const lines = code.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed) this.writeln(trimmed);
                    }
                }
            },
        };
    }

    // ─── State Accessors ─────────────────────────────────────────────

    getState() {
        return this.runner.state.status.activeState;
    }

    getMappedState() {
        const { ACTIVE_STATES } = require('./controllers/constants');
        return ACTIVE_STATES[this.getState()] || 'idle';
    }

    getPosition() {
        return this.runner.getWorkPosition();
    }

    getMachinePosition() {
        return this.runner.getMachinePosition();
    }

    getWorkflowState() {
        return this.workflow.state;
    }

    getSenderStatus() {
        return this.sender.getStatus();
    }

    getFeederStatus() {
        return this.feeder.getStatus();
    }

    getToolChangerStatus() {
        return this.toolChanger.getStatus();
    }

    getHealthMetrics() {
        return this.healthMonitor.getMetrics();
    }

    getDebugStatus() {
        return this.debugMonitor.getStatus();
    }

    getEventTriggers() {
        return this.eventTrigger.getAll();
    }

    isInitialized() {
        return this._initialized;
    }

    getSettings() {
        return this.runner.settings;
    }

    getParserState() {
        return this.runner.state.parserstate;
    }

    getOverrides() {
        return this.runner.getOverrides();
    }

    /**
     * Get comprehensive state snapshot for clients.
     */
    getFullState() {
        return {
            type: this.type,
            initialized: this._initialized,
            activeState: this.getState(),
            mappedState: this.getMappedState(),
            position: this.getPosition(),
            machinePosition: this.getMachinePosition(),
            workflowState: this.getWorkflowState(),
            sender: this.getSenderStatus(),
            feeder: this.getFeederStatus(),
            overrides: this.getOverrides(),
            parserState: this.getParserState(),
            toolChanger: this.getToolChangerStatus(),
            health: this.getHealthMetrics(),
            debug: this.getDebugStatus(),
        };
    }
}

module.exports = { GrblController };
