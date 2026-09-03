/**
 * RTSController - RealtimeCNC RTS-1 binary protocol controller.
 *
 * Implements the real binary protocol reverse-engineered from USB captures:
 *   Frame format: 0x01 [length] [command] [payload...] 0xFF
 *   - Status polling at ~10Hz via register 0xB0
 *   - Positions as IEEE 754 LE floats in 30-byte status frames
 *   - JSON config messages prefixed with 0xA0
 *   - Jog commands as 25-byte frames with 4-axis velocity vectors
 *   - G-code mode via framed ASCII (01 09 00 40 3e [ASCII] FF)
 *   - Raw GRBL commands ($I, $H) as unframed ASCII
 *
 * Protocol reference: RTS1_PROTOCOL_ANALYSIS.md
 */
const { EventEmitter } = require('events');
const logger = require('../../logger');

// ─── Protocol Constants ────────────────────────────────────────────────────

const FRAME_START = 0x01;
const FRAME_END = 0xFF;

// Command bytes (host -> device)
const CMD_QUERY = 0x00;       // Query register: 01 05 00 XX FF
const CMD_JOG = 0x20;         // Jog: 01 19 00 20 [4xF32] [4 zeros] FF
const CMD_GCODE_MODE = 0x40;  // G-code mode: 01 09 00 40 3E [ASCII] FF
const CMD_WRITE_REG = 0x82;   // Write register: 01 0B 00 82 XX YY VV VV VV VV FF
const CMD_HOME = 0x0A;        // Home command: 01 06 00 0A 01 FF (from Wireshark capture)
const CMD_JOG_MODE = 0x10;    // Jog mode enable/disable: 01 06 00 10 01/00 FF (from Wireshark capture)
const CMD_SET_HOME = 0x0B;    // Set home position (zero axis): 01 06 00 0B XX FF (decoded from Y-homing capture March 26)

// Response type bytes (device -> host)
const RESP_FIRMWARE = 0x01;   // Firmware version response
const RESP_STATUS = 0xB0;     // 30-byte position/status report
const RESP_JOG_ACK = 0xB3;   // Jog acknowledged
const RESP_JSON = 0xA0;       // JSON config message
const RESP_STATE = 0xC1;      // Machine state (00=idle, 01=moving)
const RESP_MOTION = 0xA1;     // Motion/homing phase complete (switch triggered)
const RESP_HOMING_PROGRESS = 0xA4; // Homing in progress (sent every ~250ms during seek)
const RESP_MODE_ACK = 0xBC;   // Mode change acknowledged

// Register IDs for queries
const REG_FIRMWARE = 0x01;
const REG_STATE = 0x03;
const REG_CONFIG_TYPE = 0x09;
const REG_STATUS = 0xB0;
const REG_MACHINE_STATE = 0xC1;

// Write register IDs
const WREG_INVERTED = 0x03;
const WREG_MAX_VELOCITY = 0x04;
const WREG_ACCEL = 0x05;
const WREG_PROBE_X = 0x06;
const WREG_PROBE_Y = 0x07;
const WREG_PROBE_Z = 0x08;
const WREG_HOME_OFFSET = 0x09;
const WREG_JERK = 0x0A;
const WREG_STEPS_PER_MM = 0x0B;
const WREG_MIN_LIMIT = 0x0D;
const WREG_SPINDLE_MODE = 0x0E;
const WREG_SPINDLE_DELAY = 0x14;
const WREG_PWM_FREQ = 0x15;
const WREG_PROBE_SPEED = 0x17;

// Machine state byte values from B0/C1 response
const MACHINE_STATE = {
    0x00: 'Idle',
    0x01: 'Run',
    0x02: 'Hold',
    0x03: 'Home',
    0x04: 'Alarm',
    0x05: 'Jog',
    0x08: 'Homing',
    0x09: 'MotorError',  // Closed-loop motor error (from RTS-X)
};

// Unlock/reset command (from Wireshark capture: 01 06 00 81 58 FF = binary $X)
const CMD_UNLOCK = 0x81;      // Unlock: 01 06 00 81 58 FF (0x58 = 'X' = $X equivalent)
// CMD 0x07: Clear specific motor error. Value = MOTOR INDEX (not a mode flag!)
//   0x00 = clear motor 0 (X)
//   0x01 = clear motor 1 (Y1)
//   0x02 = clear motor 2 (Y2)
//   0x03 = clear motor 3 (Z)
// RTS-1 has 4 motors: X, Y1, Y2 (dual-drive gantry), Z
// Response 0xBE = bitmask of motors in error: bit0=X, bit1=Y1, bit2=Y2, bit3=Z
const CMD_CLEAR_ERROR = 0x07;
const CMD_ZERO_AXES = 0x21;   // Zero/stop all axes: 01 15 00 21 [16 zero bytes] FF
const RESP_MOTOR_ERROR_STATUS = 0xBE; // Motor error bitmask response

// Line-ack frames the board emits while processing a streamed job:
//   0xA2  — "current line counter" advance (9 bytes total).
//   0xA6  — "now processing line" with the ASCII text echoed back
//           (e.g. payload "N32G1 X19.323 Y32.506 F400.0").
// Either one is a reliable per-line ack — we use the first to arrive
// since they fire microseconds apart. Decoded from 2026-05-13 console
// trace where the board processed our AN frames at ~1 line/sec while
// our status-frame pump was pushing at ~9 lines/sec — 11× overrun.
const RESP_LINE_COUNTER = 0xA2;
const RESP_LINE_ECHO = 0xA6;
// 0xA1 = immediate "byte received and buffered" ack. Payload is a single
// status char (e.g. 0x41 'A' = ok, 0x45 'E' = end?). Confirmed in
// 2026-05-13 09:31 test: each AN frame triggered one 0xA1 'A' ack
// within ~3 ms. This is the real per-line receipt ack.
const RESP_RX_ACK = 0xA1;

// Motor index mapping (RTS-1 has 4 motors: X, Y1, Y2, Z)
const MOTOR_INDEX = { X: 0, Y1: 1, Y2: 2, Z: 3 };
const MOTOR_NAMES = ['X', 'Y1', 'Y2', 'Z'];

// Status polling interval (10Hz = 100ms)
const STATUS_POLL_INTERVAL = 100;

// Initialization timeout
const INIT_TIMEOUT = 5000;

// Connection health timeout (no response for 3 seconds = stale)
const HEALTH_STALE_TIMEOUT = 3000;

// ─── Firmware Config Defaults (from decoded firmware) ─────────────────────
const FIRMWARE_DEFAULTS = {
    steps_per_mm: [125, 125, 200, 38.889],     // X, Y, Z, A
    max_velocity: [15240, 15240, 7620, 21600],  // mm/min
    accel: [1800000, 1800000, 1800000, 750000],
    min_travel: [0, 0, -160, -720],
    max_travel: [1227, 1228, 0, 720],
    inverted: [true, true, true, false],
};

// Jog direction multiplier for CMD_JOG (0x20) raw velocity.
// The firmware's `inverted` flag only applies to G-code motion, NOT raw jog velocity.
// These values are hardcoded based on hardware testing:
//   X/Y/Z motors are physically wired backward → negate velocity for correct direction.
//   A axis is wired correctly → no negation.
const JOG_DIRECTION = [1, 1, 1, 1]; // [X, Y, Z, A] — no negation needed, board handles direction

// Homing seek direction per axis: -1 = negative, +1 = positive
// X homes negative (confirmed by Tawfiq), Y homes negative (decoded from capture March 26)
// Z home direction TBD — defaulting to positive until captured
const HOME_DIRECTION = [-1, -1, 1, 1]; // [X, Y, Z, A]

// Per-axis 0x20 AXIS_CMD float vectors decoded byte-for-byte from a clean
// vendor-app Home All capture (May 14, sessions/.../vendor_homing_full).
// Each entry is [x, y, z, a, feed] passed directly to _sendJogFrame.
// Vendor seek distances (165 / 811) are large enough to guarantee switch
// contact; firmware stops on switch trigger before the full move.
const HOMING_VECTORS = Object.freeze({
    Z: {
        // Z back-off is BIGGER + with explicit feed because Tawfiq's Z
        // motor needs more torque to break free of the switch contact:
        //   • Mirroring X/Y exactly ([0,0,-5,0,0]) — back-off 'E' did
        //     arrive but ~8 sec out, motor barely moved, switch never
        //     properly released, Z jog after home was dead.
        //   • Bigger explicit-feed back-off ([0,0,-10,0,500]) on the
        //     v1.2.11 trace showed actual visible motion and let Z
        //     leave the switch.
        // Tawfiq's May 15 directive: "increase the back-off little more."
        fast:    [0, 0,  165, 0, 1200],   // soft fast seek (soft hit)
        backoff: [0, 0,  -10, 0,  500],   // 10 mm reverse — was 50 (msg 6782 photo showed spindle dropped 50mm)
        slow:    [0, 0,   15, 0,  200],   // 15 mm slow re-approach, feed 200
    },
    X: {
        fast:    [-811, 0, 0, 0, 2000],   // seek negative into X- switch
        backoff: [   5, 0, 0, 0,    0],   // 5 mm reverse
        slow:    [ -15, 0, 0, 0,  200],
    },
    Y: {
        fast:    [0, -811, 0, 0, 2000],
        backoff: [0,    5, 0, 0,    0],
        slow:    [0,  -15, 0, 0,  200],
    },
});

// Per-axis homing timeout. Vendor finishes each axis in 4–8 sec at the
// stock feed=2000 fast seek. With Z fast seek softened to feed=500
// (post-v1.2.8) the Z axis can take up to ~20 sec on a full 165 mm
// traversal — so 30 sec is the right balance: tolerates the softer Z
// seek plus all three vendor phases (fast / back-off / slow), still
// fails fast on a genuinely dead switch.
const HOMING_AXIS_TIMEOUT_MS = 30000;

// Homing speeds — from live stream analysis (March 26 2026)
// RTS-X uses: fast=811, backoff=5, slow=15
// We use slightly slower fast seek for smoother switch approach
const HOME_FAST_SPEED = 600;    // mm/min — fast seek (RTS-X=811, reduced for smoother hit)
const HOME_FAST_FEED = 1500;    // mm/min — feed rate (RTS-X=2000, reduced for softer approach)
const HOME_BACKOFF_SPEED = 10;  // mm/min — reverse off switch (RTS-X=5, increased for faster backoff)
const HOME_BACKOFF_FEED = 0;    // feed=0 (board uses velocity directly)
const HOME_SLOW_SPEED = 15;     // mm/min — slow precise re-approach (matches RTS-X)
const HOME_SLOW_FEED = 200;     // mm/min — feed rate for slow seek (matches RTS-X)
const HOME_Z_SPEED = 165;       // mm/min — Z axis seek speed (from live stream)

// ─── Controller ────────────────────────────────────────────────────────────

class RTSController extends EventEmitter {
    constructor() {
        super();

        this.type = 'RTS';

        /** @type {import('../Connection').Connection|null} */
        this.connection = null;

        /** @type {Buffer} Incoming raw byte buffer for frame parsing */
        this._rxBuffer = Buffer.alloc(0);

        /** @type {boolean} Whether we have completed initialization */
        this._initialized = false;

        /** @type {NodeJS.Timeout|null} Status polling timer */
        this._pollTimer = null;

        /** @type {NodeJS.Timeout|null} Init timeout timer */
        this._initTimer = null;

        /** @type {NodeJS.Timeout|null} Jog stop timer for step jogs */
        this._jogStopTimer = null;

        /** @type {object|null} Active jog target for position monitoring */
        this._jogTarget = null;

        /** @type {boolean} Whether jogging is active (suppresses polling) */
        this._jogActive = false;

        /** @type {boolean} Whether a write is in progress (serializes writes) */
        this._writing = false;

        /** @type {Array} Pending write queue */
        this._writeQueue = [];

        /** @type {boolean} Whether we received the initial idle message */
        this._gotIdleMsg = false;

        // ─── Connection Health ──────────────────────────────────────
        /** @type {number} Timestamp of last response from board */
        this._lastResponseTime = 0;

        /** @type {NodeJS.Timeout|null} Health check timer */
        this._healthTimer = null;

        /** @type {number} Count of missed polls */
        this._missedPolls = 0;

        // ─── Firmware Config (from decoded firmware defaults) ────────
        /** @type {object} Machine config from firmware */
        this._firmwareConfig = { ...FIRMWARE_DEFAULTS };

        // ─── Motor Reset Grace Period ────────────────────────────────
        /** @type {number} Timestamp when motor reset was last sent (suppresses MotorError for grace period) */
        this._motorResetTime = 0;

        // ─── Homing State ───────────────────────────────────────────
        /** @type {boolean} Whether homing is in progress */
        this._homing = false;

        /** @type {string|null} Which axis is being homed (null = all) */
        this._homingAxis = null;

        /** @type {string[]} Queue of axes remaining to home */
        this._homingQueue = [];

        // ─── Machine State ──────────────────────────────────────────

        /** @type {string} Current machine state for UI */
        this._activeState = 'Idle';

        /** @type {object} Machine positions (from B0 status) */
        this._mpos = { x: 0, y: 0, z: 0, a: 0 };

        /** @type {object} Work positions (calculated from mpos - wco) */
        this._wpos = { x: 0, y: 0, z: 0, a: 0 };

        /** @type {object} Work coordinate offsets */
        this._wco = { x: 0, y: 0, z: 0, a: 0 };

        /** @type {number} Status flags byte from B0 response */
        this._statusFlags = 0;

        /** @type {number} State byte from B0 response */
        this._stateByte = 0;

        /** @type {object} Feed/rapid/spindle overrides */
        this._overrides = { feed: 100, rapid: 100, spindle: 100 };

        /** @type {number} Current feedrate */
        this._feedrate = 0;

        /** @type {number} Current spindle speed */
        this._spindleSpeed = 0;

        /** @type {string} Spindle direction M-code */
        this._spindleDir = 'M5';

        // ─── Firmware / Config ──────────────────────────────────────

        /** @type {string} Firmware version string */
        this._firmwareVersion = '';

        /** @type {object} Board settings (from JSON config dump) */
        this._settings = {};

        /** @type {Array} Work coordinate offset table (G54-G59+) */
        this._offsets = [];

        /** @type {string} Board serial number */
        this._serialNumber = '';

        // ─── G-code Sender State ────────────────────────────────────

        /** @type {string[]} Loaded G-code lines */
        this._gcodeLines = [];

        /** @type {number} Current line index */
        this._gcodeIndex = 0;

        /** @type {boolean} Whether a job is running */
        this._running = false;

        /** @type {boolean} Whether the job is paused (user-initiated) */
        this._paused = false;

        /**
         * Whether the board is currently reporting Hold (board-initiated pause).
         * Distinct from `_paused` which is user-initiated. Streaming halts on
         * either flag; resumes when both clear.
         * @type {boolean}
         */
        this._boardHolding = false;

        /**
         * Last line number the board ack'd via 0xA2/0xA6. Used to de-dupe
         * pump calls because the board emits both ack types ~1ms apart per
         * line — we only want to advance once.
         * @type {number|null}
         */
        this._lastAckedLine = null;

        /** @type {NodeJS.Timeout|null} 500ms safety timer that fires if a line
         *  produces no ack (modal-set lines G21/G90/F-only don't emit 0xA1).
         *  Per streaming-stall fix (Tawfiq msg 6965). */
        this._ackTimer = null;

        /** @type {number} Last 1-based line number we sent — used by the
         *  safety timer to check we haven't already moved past it. */
        this._lastSentLineNum = 0;

        /**
         * setTimeout handle for the auto cycle-start 500ms after _startJob.
         * Cleared on _stopJob to avoid firing a stray 0x06 into a cancelled
         * stream.
         * @type {NodeJS.Timeout|null}
         */
        this._cycleStartTimer = null;

        // vendor-pcap-v1 (msg 7084) — bulk-push streaming + buffer polling state
        this._bufferPollTimer = null;
        this._suppressAckAdvance = false;
        this._bufferPollLogCount = 0;
        // vendor-pcap-v2 (msg 7092 chess pcap) — ack-driven push state
        this._bulkSendOne = null;
        this._bulkAckTimer = null;
        this._bulkCycleStartFired = false;
        // vendor-pcap-v3 (msg 7099 chess stall) — B-ack retransmit state
        this._bulkAckIsRetry = false;
        this._bulkRetryCount = 0;

        /**
         * setInterval handle for the loop-back stream pump (Stage 17).
         * Pumps lines at 5 ms intervals, ADVANCING the send pointer on
         * every send. When the pointer reaches end-of-file, it wraps
         * back to 0 and re-streams. This matches the vendor wire trace
         * exactly — 463 unique lines were sent 66,013 times in their
         * pcap (~143 retransmits each via ~87 passes through the file).
         * Stop condition: _executedCount >= _gcodeLines.length.
         * @type {NodeJS.Timeout|null}
         */
        this._streamPumpInterval = null;

        /**
         * Count of 0xA1 'B' (executed) acks received. The firmware emits
         * one 'B' per line as it physically actuates. Job completes when
         * this matches total line count. Reset by _startJobInternal.
         * @type {number}
         */
        this._executedCount = 0;

        /**
         * Pass counter (for diagnostics + safety bound on infinite loops).
         * @type {number}
         */
        this._streamPassCount = 0;

        /** @type {number} Job start timestamp */
        this._jobStartTime = 0;

        // ─── State object for CNCEngine compatibility ───────────────

        this.state = {
            status: {},
            parserstate: {
                modal: {
                    motion: 'G0',
                    wcs: 'G54',
                    plane: 'G17',
                    units: 'G21',
                    distance: 'G90',
                    feedrate: 'G94',
                    program: 'M0',
                    spindle: 'M5',
                    coolant: 'M9',
                },
                tool: 0,
                feedrate: 0,
                spindle: 0,
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Connection Binding
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Bind to a Connection instance.
     * @param {import('../Connection').Connection} connection
     */
    bind(connection) {
        this.connection = connection;

        // Listen for raw binary data
        connection.on('rawData', (buf) => this._onRawData(buf));

        // Also listen for text data (for GRBL responses like $I)
        connection.on('data', (data) => {
            // In raw mode, 'data' events carry Buffers, not strings
            // Only handle string data here (text-mode fallback)
            if (typeof data === 'string') {
                this._onTextData(data);
            }
        });

        connection.on('close', () => {
            const stack = new Error().stack;
            logger.error(`[RTS] Connection CLOSED — stack: ${stack}`);
            this._activeState = 'Alarm';
            this._stopPolling();
            this._clearInitTimer();
            // Clean up any active jog timer (don't write to closed connection)
            if (this._jogStopTimer) {
                clearTimeout(this._jogStopTimer);
                this._jogStopTimer = null;
            }
            this._jogTarget = null;
            this._jogActive = false;
            this._writing = false;
            this._writeQueue = [];
            this.emit('close');
        });

        connection.on('error', (err) => {
            logger.error(`[RTS] Connection ERROR: ${err?.message} — stack: ${err?.stack}`);
            this.emit('error', { message: err?.message });
        });

        // Start initialization sequence
        this._startInit();
    }

    /**
     * Unbind from the connection.
     */
    unbind() {
        this._stopPolling();
        this._stopHealthMonitor();
        this._clearInitTimer();
        if (this._jogStopTimer) {
            clearTimeout(this._jogStopTimer);
            this._jogStopTimer = null;
        }

        if (this.connection) {
            this.connection.removeAllListeners('rawData');
            this.connection.removeAllListeners('data');
            this.connection.removeAllListeners('close');
            this.connection.removeAllListeners('error');
        }

        this.connection = null;
        this._initialized = false;
        this._running = false;
        this._paused = false;
        this._homing = false;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Initialization Sequence
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Start the initialization sequence.
     * Per the protocol analysis:
     *   1. Wait for board idle message (01 05 C1 00 FF)
     *   2. Query register 0x09
     *   3. Send $I (GRBL info)
     *   4. Query firmware version (register 0x01)
     *   5. Start status polling
     */
    _startInit() {
        this._initialized = false;
        this._gotIdleMsg = false;
        this._rxBuffer = Buffer.alloc(0);

        logger.info('[RTS] Starting initialization sequence');

        // Send initial queries after a short delay (board may need time)
        setTimeout(() => {
            if (!this.connection) return;

            // Query register 0x09 (machine config)
            this._sendQueryFrame(REG_CONFIG_TYPE);

            // Send $I for GRBL info (raw ASCII, no framing)
            this._writeAscii('$I\n');

            // Query firmware version
            setTimeout(() => {
                if (!this.connection) return;
                this._sendQueryFrame(REG_FIRMWARE);
            }, 200);
        }, 500);

        // Set init timeout - if we don't get a response, start polling anyway
        this._initTimer = setTimeout(() => {
            if (!this._initialized) {
                logger.warn('[RTS] Init timeout - starting polling without full init');
                this._completeInit();
            }
        }, INIT_TIMEOUT);
    }

    /**
     * Complete initialization and start status polling.
     */
    _completeInit() {
        if (this._initialized) return;
        this._initialized = true;
        this._clearInitTimer();
        this._lastResponseTime = Date.now();

        logger.info(`[RTS] Initialization complete - firmware: ${this._firmwareVersion || 'unknown'}`);

        // Update state
        this._updateStateObject();

        // Emit initialized event
        this.emit('initialized', {
            firmwareType: 'RTS',
            firmwareVersion: this._firmwareVersion || 'unknown',
        });

        // Emit initial state
        this.emit('state', this.getState());
        this.emit('status', this.state.status);

        // Stage 18 P2: do NOT push machine config at init. The vendor pcap
        // reads board config (queries register 0x09) but never writes back.
        // Writing to the firmware's settings at startup appears to put it
        // into a state that throttles execution aggressively and stalls the
        // stream mid-job. _pushMachineConfig() is still available for an
        // explicit user-driven settings change but is no longer auto-called.
        // this._pushMachineConfig();  // disabled — see Stage 18 commit msg

        // Start 10Hz status polling
        this._startPolling();

        // Start connection health monitoring
        this._startHealthMonitor();
    }

    _clearInitTimer() {
        if (this._initTimer) {
            clearTimeout(this._initTimer);
            this._initTimer = null;
        }
    }

    /**
     * Push machine config to the board via SET commands (register 0x82).
     * The RTS-X software does this at startup before any jog/home commands.
     * Without it, the board may not accept motion commands properly.
     */
    _pushMachineConfig() {
        const cfg = this._firmwareConfig;
        logger.info('[RTS] Pushing machine config to board (matching RTS-X startup)');

        // Inverted flags (uint32, not float)
        for (let i = 0; i < 4; i++) {
            this._sendWriteRegister(WREG_INVERTED, i, cfg.inverted[i] ? 1 : 0, false);
        }
        // Steps per mm
        for (let i = 0; i < 4; i++) {
            this._sendWriteRegister(WREG_STEPS_PER_MM, i, cfg.steps_per_mm[i]);
        }
        // Max velocity
        for (let i = 0; i < 4; i++) {
            this._sendWriteRegister(WREG_MAX_VELOCITY, i, cfg.max_velocity[i]);
        }
        // Acceleration
        for (let i = 0; i < 4; i++) {
            this._sendWriteRegister(WREG_ACCEL, i, cfg.accel[i]);
        }
        // Travel limits
        for (let i = 0; i < 4; i++) {
            this._sendWriteRegister(WREG_HOME_OFFSET, i, 0); // Home offset = 0
        }
        // Max travel (stored as register 0x0A in RTS-X)
        for (let i = 0; i < 4; i++) {
            this._sendWriteRegister(WREG_JERK, i, cfg.max_travel[i]);
        }
        // Min travel (register 0x0D)
        for (let i = 0; i < 4; i++) {
            this._sendWriteRegister(WREG_MIN_LIMIT, i, cfg.min_travel[i]);
        }
        // Probe settings
        this._sendWriteRegister(WREG_PROBE_SPEED, 0, 1000);
        this._sendWriteRegister(WREG_PROBE_X, 0, 54);
        this._sendWriteRegister(WREG_PROBE_Y, 0, 54);
        this._sendWriteRegister(WREG_PROBE_Z, 0, 15);
        // Spindle defaults
        this._sendWriteRegister(WREG_SPINDLE_MODE, 0, 0, false);

        // Send G54 and G21 (metric) like RTS-X does
        setTimeout(() => {
            if (this.connection) {
                this._sendGcodeMode('G54');
                this._sendGcodeMode('G21');
                logger.info('[RTS] Machine config push complete');
            }
        }, 500);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Raw Data Handling & Frame Parser
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Handle incoming raw binary data from the serial port.
     * Buffers bytes and extracts complete frames.
     * @param {Buffer} data
     */
    _onRawData(data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this._rxBuffer = Buffer.concat([this._rxBuffer, buf]);

        // Extract all complete frames from the buffer
        this._parseFrames();
    }

    /**
     * Handle text data (for GRBL ASCII responses).
     * @param {string} line
     */
    _onTextData(line) {
        const trimmed = line.trim();
        if (!trimmed) return;

        // Only show meaningful text responses, skip noise
        if (trimmed.startsWith('[') || trimmed.startsWith('ok') || trimmed.startsWith('error:') || trimmed.startsWith('ALARM')) {
            this.emit('console', trimmed);
        }

        // GRBL responses
        if (trimmed.startsWith('[VER:') || trimmed.startsWith('[OPT:')) {
            logger.info(`[RTS] GRBL info: ${trimmed}`);
        } else if (trimmed.startsWith('ok')) {
            this._onAck();
        } else if (trimmed.startsWith('error:')) {
            this.emit('error', { message: trimmed });
        }
    }

    /**
     * Scan the receive buffer for complete binary frames.
     * Frame format: 0x01 [length] [payload...] 0xFF
     * Length byte = total frame size including 0x01 and 0xFF.
     */
    _parseFrames() {
        while (this._rxBuffer.length >= 3) {
            // Find start byte
            const startIdx = this._rxBuffer.indexOf(FRAME_START);
            if (startIdx === -1) {
                // No start byte found - discard buffer
                this._rxBuffer = Buffer.alloc(0);
                return;
            }

            // Discard bytes before start
            if (startIdx > 0) {
                // Check if discarded bytes contain ASCII text (GRBL responses)
                const discarded = this._rxBuffer.slice(0, startIdx);
                this._tryParseAscii(discarded);
                this._rxBuffer = this._rxBuffer.slice(startIdx);
            }

            // Need at least 2 bytes for start + length
            if (this._rxBuffer.length < 2) return;

            const frameLen = this._rxBuffer[1];

            // Sanity check on length
            if (frameLen < 3 || frameLen > 250) {
                // Invalid length - skip this start byte and try next
                this._rxBuffer = this._rxBuffer.slice(1);
                continue;
            }

            // Wait for complete frame
            if (this._rxBuffer.length < frameLen) return;

            // Verify end byte
            if (this._rxBuffer[frameLen - 1] !== FRAME_END) {
                // Bad frame - skip start byte
                logger.warn(`[RTS] Bad frame end byte at length ${frameLen}: 0x${this._rxBuffer[frameLen - 1].toString(16)}`);
                this._rxBuffer = this._rxBuffer.slice(1);
                continue;
            }

            // Extract complete frame
            const frame = this._rxBuffer.slice(0, frameLen);
            this._rxBuffer = this._rxBuffer.slice(frameLen);

            // Process the frame (try-catch prevents parser crash from killing connection)
            try {
                this._handleFrame(frame);
            } catch (err) {
                logger.error(`[RTS] Error handling frame ${frame.toString('hex')}: ${err.message}`);
            }
        }
    }

    /**
     * Try to parse discarded bytes as ASCII text (GRBL responses).
     * @param {Buffer} data
     */
    _tryParseAscii(data) {
        const text = data.toString('utf-8').trim();
        if (!text) return;

        // Split by newlines and process each line
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
                this._onTextData(trimmed);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Frame Handlers
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Dispatch a complete binary frame to the appropriate handler.
     * @param {Buffer} frame - Complete frame including 0x01 and 0xFF
     */
    _handleFrame(frame) {
        const len = frame[1];
        const cmdByte = frame[2];

        const frameHex = frame.toString('hex');
        logger.debug(`[RTS] Frame: ${frameHex} (cmd=0x${cmdByte.toString(16)}, len=${len})`);

        // Don't spam console with raw hex — only log important events below

        switch (cmdByte) {
            case RESP_STATUS: // 0xB0 - Position/status report (30 bytes)
                this._handleStatusFrame(frame);
                break;

            case RESP_STATE: // 0xC1 - Machine state
                this._handleStateFrame(frame);
                break;

            case RESP_JSON: // 0xA0 - JSON config message
                this._handleJsonFrame(frame);
                break;

            case RESP_FIRMWARE: // 0x01 - Firmware version
                this._handleFirmwareFrame(frame);
                break;

            case RESP_JOG_ACK: // 0xB3 - Jog acknowledged
                this._handleJogAck(frame);
                break;

            case RESP_MOTION: // 0xA1 - Motion complete
                this._handleMotionComplete(frame);
                break;

            case RESP_MOTOR_ERROR_STATUS: // 0xBE - Motor error bitmask
                this._handleMotorErrorStatus(frame);
                break;

            case RESP_LINE_COUNTER: // 0xA2 - per-line counter advance
            case RESP_LINE_ECHO:    // 0xA6 - per-line text echo
                this._handleLineAck(frame, cmdByte);
                break;
                // NOTE: 0xA1 (RESP_RX_ACK) is handled by _handleMotionComplete
                // above — the per-line streaming ack lives inside that handler
                // because 0xA1 is also "motion complete" outside of streaming.

            case 0xD5: // requestStreamBuffer response: 01 06 D5 <free> <max> FF
            case 0xD6: // requestMotorBuffer response:  01 06 D6 <free> <max> FF
                // 2-byte payload after opcode. Used for back-pressure
                // diagnostics — log periodically, no action yet.
                if (frame.length >= 6 && (this._bufferPollLogCount = (this._bufferPollLogCount || 0) + 1) % 50 === 0) {
                    logger.debug(`[RTS] 0x${cmdByte.toString(16).toUpperCase()} buffer: free=${frame[3]}/${frame[4]}`);
                }
                break;
            case 0xD7: // requestCurrentLine response: 01 08 D7 <line LE32> FF
                if (frame.length >= 8) {
                    const currentLine = frame[3] | (frame[4] << 8) | (frame[5] << 16) | (frame[6] << 24);
                    // Detect job completion: board reports a line >= total OR
                    // current line stops advancing for several polls.
                    const total = this._gcodeLines.length;
                    if (currentLine >= total && this._running) {
                        logger.info(`[RTS] 0xD7 reports currentLine=${currentLine} >= total=${total} — job complete`);
                        this._stopBufferPolling();
                        this._running = false;
                        this.emit('sender:end');
                        this.emit('workflow:state', 'idle');
                    }
                    // Update progress with REAL board-reported line number
                    this.emit('sender:status', {
                        sent: this._gcodeIndex,
                        total,
                        received: currentLine,
                        startedAt: this._jobStartTime,
                        elapsedTime: Date.now() - (this._jobStartTime || Date.now()),
                        remainingTime: 0,
                    });
                }
                break;

            default:
                // Log unrecognized frames for protocol analysis
                logger.info(`[RTS] Unknown frame cmd=0x${cmdByte.toString(16)}: ${frameHex}`);
                break;
        }
    }

    /**
     * Parse 30-byte status frame (0xB0).
     * Format: 01 1E B0 [state] [flags] [X_f32] [Y_f32] [Z_f32] [A_f32] [?_f32] [?_f32] FF
     *
     * Offsets (0-indexed from frame start):
     *   [0]  = 0x01 (start)
     *   [1]  = 0x1E (30 = length)
     *   [2]  = 0xB0 (command)
     *   [3]  = state byte
     *   [4]  = flags byte
     *   [5-8]   = X position (float32 LE)
     *   [9-12]  = Y position (float32 LE)
     *   [13-16] = Z position (float32 LE)
     *   [17-20] = A position (float32 LE)
     *   [21-24] = unknown float (possibly feed rate or velocity)
     *   [25-28] = unknown float
     *   [29] = 0xFF (end)
     */
    _handleStatusFrame(frame) {
        if (frame.length < 30) {
            logger.warn(`[RTS] Short status frame: ${frame.length} bytes`);
            return;
        }

        // Track connection health
        this._lastResponseTime = Date.now();
        this._missedPolls = 0;

        const stateByte = frame[3];
        const flags = frame[4];

        // Read positions as IEEE 754 LE floats
        const x = frame.readFloatLE(5);
        const y = frame.readFloatLE(9);
        const z = frame.readFloatLE(13);
        const a = frame.readFloatLE(17);

        // Unknown floats (possibly velocity/feedrate)
        const unk1 = frame.readFloatLE(21);
        const unk2 = frame.readFloatLE(25);

        // Update state
        this._stateByte = stateByte;
        this._statusFlags = flags;

        // Map state byte to active state
        const prevState = this._activeState;
        const mappedState = MACHINE_STATE[stateByte] || 'Idle';

        // Grace period after motor reset/unlock: suppress MotorError/Alarm for 3 seconds
        // to let the board process the reset command before re-reporting error
        const isErrorState = mappedState === 'MotorError' || mappedState === 'Alarm';
        if (isErrorState && this._motorResetTime > 0 &&
            (Date.now() - this._motorResetTime) < 3000) {
            this._activeState = 'Idle';
            logger.debug(`[RTS] Suppressing ${mappedState} during reset grace period`);
        } else {
            if (!isErrorState) {
                this._motorResetTime = 0; // Clear grace period once board reports non-error
            }
            this._activeState = mappedState;
        }

        // ECSS Module 3 — Z runaway watchdog.
        // DISABLED on vendor-pcap-v1 branch per Tawfiq msg 7097 — was
        // false-positive firing on his uncalibrated Z (board reports
        // ~4x commanded feed = steps/mm off, but vendor RTS-X presumably
        // tolerates this so we should too for diagnostic test runs).
        // CAUTION: bit can crash into bed/material with no host-side
        // protection. Re-enable in a future commit once calibration is
        // sorted OR replace with a "deviation-from-commanded-Z" check.
        if (process.env.EASYCNC_Z_RUNAWAY_ENABLE === '1') {
            const prevZ = this._mpos.z;
            const newZ = this._roundPos(z);
            if (this._running && typeof prevZ === 'number' && typeof newZ === 'number') {
                const RUNAWAY_DROP_MM = 20;
                const RUNAWAY_WINDOW_MS = 3000;
                if (!this._zRunawayHistory) this._zRunawayHistory = [];
                const now = Date.now();
                this._zRunawayHistory.push({ t: now, z: newZ });
                while (this._zRunawayHistory.length && now - this._zRunawayHistory[0].t > RUNAWAY_WINDOW_MS) {
                    this._zRunawayHistory.shift();
                }
                const oldest = this._zRunawayHistory[0];
                if (oldest && (oldest.z - newZ) > RUNAWAY_DROP_MM && !this._zRunawayFired) {
                    this._zRunawayFired = true;
                    const drop = Math.round((oldest.z - newZ) * 1000) / 1000;
                    const ms = now - oldest.t;
                    logger.error(`[ECSS] Z RUNAWAY ABORT — Z dropped ${drop} mm in ${ms} ms (limit: ${RUNAWAY_DROP_MM} mm / ${RUNAWAY_WINDOW_MS} ms). Firing 0x03.`);
                    this.emit('safety:zRunaway', { drop, windowMs: ms, threshold: RUNAWAY_DROP_MM, mposZ: newZ });
                    try { this._softReset(); } catch (e) { /* still abort downstream */ }
                    this._running = false;
                    this.emit('console', `ECSS Z-RUNAWAY ABORT: Z dropped ${drop} mm in ${ms} ms — stream stopped.`);
                    this.emit('sender:end');
                    this.emit('workflow:state', 'idle');
                }
            }
        }

        // Update machine position
        this._mpos.x = this._roundPos(x);
        this._mpos.y = this._roundPos(y);
        this._mpos.z = newZ;
        this._mpos.a = this._roundPos(a);

        // Calculate work position
        this._wpos.x = this._roundPos(x - this._wco.x);
        this._wpos.y = this._roundPos(y - this._wco.y);
        this._wpos.z = this._roundPos(z - this._wco.z);
        this._wpos.a = this._roundPos(a - this._wco.a);

        // Store unknown floats (may be useful later)
        this._feedrate = this._roundPos(unk1);

        // Update state object
        this._updateStateObject();

        // Emit events
        this.emit('status', this.state.status);
        this.emit('position', this.getPosition());

        // Stream pump: refresh _boardHolding + send next line on every status
        // frame (one line per ~110ms poll). Replaces the old "wait for ok"
        // model since the firmware doesn't emit "ok" for AN-framed streaming.
        this._onStreamTick();

        if (prevState !== this._activeState) {
            this.emit('state', this.getState());

            // Show clean state change in console
            const stateIcons = { Idle: '✅', Run: '▶️', Home: '🏠', Homing: '🏠', Hold: '⏸️', Alarm: '🚨', Jog: '🕹️', MotorError: '⚠️' };
            const icon = stateIcons[this._activeState] || '🔄';
            this.emit('console', `${icon} State: ${this._activeState}`);

            // Emit alarm event when entering alarm or error state
            if (this._activeState === 'Alarm') {
                this.emit('alarm', { code: stateByte, message: 'Machine is in alarm state. Clear with Unlock ($X).' });
                this.emit('console', `🚨 ALARM: Machine locked (code ${stateByte}). Press Reset to clear.`);
            }
            if (this._activeState === 'MotorError') {
                this.emit('alarm', { code: stateByte, message: 'Motor error detected — closed-loop position error. Check motor wiring and reset.' });
                this.emit('console', `⚠️ MOTOR ERROR: Closed-loop position error detected! Position: X=${this._mpos.x} Y=${this._mpos.y} Z=${this._mpos.z}. Press Reset to clear.`);
            }

            // Detect homing state transitions.
            //
            // The vendor pcap (May 14 home-all capture) shows the firmware
            // does NOT use state byte 0x00. Instead it lives at 0x01 when
            // ready/idle, 0x02 when streaming a job, 0x08 while a homing
            // cycle is in progress. Our MACHINE_STATE map calls 0x01
            // 'Run' — so the switch-hit transition is 0x08 → 0x01, which
            // in our string vocabulary is 'Homing' → 'Run' (with 'Run'
            // here meaning "idle after homing", not "executing").
            //
            // Treat any non-Homing destination as "switch hit / motion
            // stopped". 'Idle' (0x00) covers boards that do use that
            // code, 'Run' (0x01) covers the vendor firmware Tawfiq runs.
            const homingDone = this._activeState === 'Idle' || this._activeState === 'Run';
            if (this._homing && (prevState === 'Home' || prevState === 'Homing') && homingDone) {
                // If in fast_seek phase, switch has been triggered → start back-off
                if (this._homingPhase === 'fast_seek') {
                    this._startHomingBackoff();
                } else if (!this._homingPhase || this._homingPhase === 'set_home') {
                    // Final completion
                    this._onHomingComplete();
                }
            }
        }

        // Check if step jog has reached target distance
        this._checkJogTarget();

        // Complete init if not done yet (first status = board is alive)
        if (!this._initialized) {
            this._completeInit();
        }
    }

    /**
     * Parse machine state frame (0xC1).
     * Format: 01 05 C1 XX FF (XX: 00=idle, 01=moving, etc.)
     */
    _handleStateFrame(frame) {
        if (frame.length < 5) return;

        // Track connection health
        this._lastResponseTime = Date.now();

        const stateVal = frame[3];
        const prevState = this._activeState;

        logger.info(`[RTS] Machine state: 0x${stateVal.toString(16)} (${MACHINE_STATE[stateVal] || 'unknown'})`);

        const mappedStateC1 = MACHINE_STATE[stateVal] || 'Idle';

        // Grace period after motor reset/unlock: suppress MotorError/Alarm for 3 seconds
        const isErrorStateC1 = mappedStateC1 === 'MotorError' || mappedStateC1 === 'Alarm';
        if (isErrorStateC1 && this._motorResetTime > 0 &&
            (Date.now() - this._motorResetTime) < 3000) {
            this._activeState = 'Idle';
            logger.debug(`[RTS] Suppressing ${mappedStateC1} during reset grace period (C1)`);
        } else {
            if (!isErrorStateC1) {
                this._motorResetTime = 0;
            }
            this._activeState = mappedStateC1;
        }
        this._gotIdleMsg = true;

        if (prevState !== this._activeState) {
            this._updateStateObject();
            this.emit('state', this.getState());
            this.emit('status', this.state.status);
        }

        // Stream pump: refresh hold flag + pump next line every state frame
        // (whether or not it's a transition). See _onStreamTick.
        this._onStreamTick();

        if (prevState !== this._activeState) {

            if (this._activeState === 'Alarm') {
                this.emit('alarm', { code: stateVal, message: 'Machine is in alarm state. Clear with Unlock ($X).' });
            }

            // Detect homing completion. Same Idle-or-Run rule as the B0
            // status-frame handler above (vendor firmware uses 0x01 as the
            // ready-state code, which maps to 'Run' in our table).
            if (this._homing && prevState === 'Home' && (this._activeState === 'Idle' || this._activeState === 'Run')) {
                this._onHomingComplete();
            }
        }

        // If we get idle during init, it means the board is ready
        if (!this._initialized && stateVal === 0x00) {
            logger.info('[RTS] Got initial idle message from board');
        }
    }

    /**
     * Parse JSON config frame (0xA0).
     * Format: 01 [len] A0 {"msgType":"...", ...} FF
     * The JSON text spans from byte 3 to byte (len-2).
     */
    _handleJsonFrame(frame) {
        this._lastResponseTime = Date.now();
        try {
            // Extract JSON string between A0 byte and FF byte
            const jsonBytes = frame.slice(3, frame.length - 1);
            const jsonStr = jsonBytes.toString('utf-8');

            const msg = JSON.parse(jsonStr);
            logger.info(`[RTS] JSON: ${jsonStr.substring(0, 200)}`);

            // Only show important JSON config messages, skip noisy ones
            if (msg.msgType === 'settings') {
                this.emit('console', `⚙️ Config: ${msg.parameter} = ${msg.value}`);
            }

            if (msg.msgType === 'settings') {
                this._handleSettingMsg(msg);
            } else if (msg.msgType === 'offsets') {
                this._handleOffsetsMsg(msg);
            } else if (msg.msgType === 'fileCount' || msg.msgType === 'fileInfo') {
                this.emit('fileInfo', msg);
            } else {
                logger.info(`[RTS] Unknown JSON msgType: ${msg.msgType}`);
            }
        } catch (err) {
            logger.warn(`[RTS] JSON parse error: ${err.message}`);
        }
    }

    /**
     * Parse firmware version frame.
     * Format: 01 08 01 VV VV VV VV FF (version bytes)
     */
    _handleFirmwareFrame(frame) {
        if (frame.length < 5) return;

        // Extract version bytes (skip start, len, cmd byte)
        const versionBytes = [];
        for (let i = 3; i < frame.length - 1; i++) {
            versionBytes.push(frame[i]);
        }
        this._firmwareVersion = versionBytes.join('.');

        logger.info(`[RTS] Firmware version: ${this._firmwareVersion}`);

        // Complete init now that we have the firmware version
        if (!this._initialized) {
            // Start polling immediately, config will come later
            this._completeInit();
        }
    }

    /**
     * Handle jog acknowledge frame (0xB3).
     * Format: 01 05 B3 XX FF (XX: 01=moving)
     */
    _handleJogAck(frame) {
        if (frame.length < 5) return;
        const val = frame[3];
        logger.debug(`[RTS] Jog ack: state=0x${val.toString(16)}`);
        if (val === 0x01) {
            this._activeState = 'Jog';
            this._updateStateObject();
            this.emit('state', this.getState());
        }
    }

    /**
     * Handle 0xA1 frame. Dual-purpose:
     *   1. Motion / homing phase complete (when no job is streaming).
     *   2. Per-line receive ack during streaming. Payload byte 'A' (0x41)
     *      means the firmware accepted the previous AN frame into its
     *      input buffer — pump the next one. Payload 'E' (0x45) is some
     *      other status we don't pump on.
     *
     * Stage 9 trace from 2026-05-13 11:58 showed 0xA1 frames arriving
     * 36× total (2× 'A', 34× 'E') but the dispatch was routing them all
     * to this method instead of _handleLineAck — fixed by merging the
     * pump trigger into here.
     */
    _handleMotionComplete(frame) {
        logger.debug(`[RTS] 0xA1 frame: ${frame.toString('hex')}`);
        const status = frame[3];
        // ── Homing path (v1.2.6) ───────────────────────────────────────
        //
        // On Tawfiq's firmware the state byte stays at 0x08 for the entire
        // homing cycle — it does NOT transition to 0x01 when the switch is
        // hit. The reliable switch-hit notification is a standalone 0xa1
        // frame with payload 'E' (0x45). Live trace 2026-05-14 17:50:
        //   t=24.165   RX  0105 a1 45 ff         ← 'E' = switch tripped
        //   t=24.177   RX  state 0x08 sub=0x00   ← motion stopped
        if (this._homing && status === 0x45) {
            logger.info(`[RTS] Homing ${this._homingAxis}: 0xa1 'E' — switch trigger / motion stopped (phase=${this._homingPhase})`);
            if (this._homingPhase === 'fast_seek') {
                this._startHomingBackoff();
            } else if (this._pendingMotionCallback) {
                const cb = this._pendingMotionCallback;
                this._pendingMotionCallback = null;
                setTimeout(() => { if (this._homing) cb(); }, 100);
            }
            return;
        }

        // ── Streaming path ──
        // 0xA1 'A' (0x41) = line accepted INTO PLANNER → advance.
        // 0xA1 'B' (0x42) = stream-buffered or planner-full → RETRANSMIT same line.
        //
        // Per chess pcap analysis (msg 7099 stall — revised understanding):
        // vendor TX'd 60,522 frames for 2,674 unique lines (avg 22.6x
        // per line). Only 371 'A' acks. The 22:1 B:A ratio is the
        // vendor RETRANSMITTING the same line on B until it gets A.
        // Without retransmit, lines past the planner+stream-buffer
        // capacity get silently dropped → machine stops mid-job after
        // executing only the first chunk (= exactly what Tawfiq saw
        // in msg 7099: "stops after first square carving").
        if (status === 0x41 || status === 0x42) {
            this._clearAckTimeout();
            this._acceptedCount++;
            if (this._suppressAckAdvance) {
                this._emitSenderStatus();
                if (this._bulkAckTimer) {
                    clearTimeout(this._bulkAckTimer);
                    this._bulkAckTimer = null;
                }
                if (status === 0x41) {
                    // A = line in planner → advance
                    this._bulkAckIsRetry = false;
                    if (this._bulkSendOne) this._bulkSendOne();
                } else {
                    // B = retransmit same line (don't advance pointer).
                    // The streamer's _gcodeIndex has already moved past
                    // this line because _bulkSendOne incremented it BEFORE
                    // TX. Decrement so the next _bulkSendOne re-sends it.
                    this._bulkAckIsRetry = true;
                    if (this._bulkSendOne) this._bulkSendOne();
                }
            } else {
                this._emitSenderStatus();
                this._sendNextGcodeLine();
            }
        }

        // Stage 17: loop-back retransmit model for streaming jobs.
        //   Pump sends lines at 5 ms intervals, advances the send pointer
        //   on every send, loops back to start when end-of-file is hit.
        //   Firmware dedupes by line number — every line gets re-sent
        //   multiple times across passes, so dropped lines auto-recover.
        //   'A' acks are noise; 'B' acks indicate physical execution.
        //   Job done = _executedCount has caught up to _gcodeLines.length.
        if (!this._running || this._paused || this._boardHolding) return;
        if (status === 0x42) {
            this._executedCount++;
            this._emitSenderStatus();
            if (this._executedCount >= this._gcodeLines.length) {
                logger.info(`[RTS] Stream complete — ${this._executedCount} 'B' acks received, all lines executed`);
                this._stopStreamPump();
                this._running = false;
                this.emit('sender:end');
                this.emit('workflow:state', 'idle');
            }
        }
        // 0x41 'A' acks: silent — firmware is buffering, pump keeps cycling.
    }

    /**
     * Start the 5 ms stream pump. Every tick, if the job is running and
     * the board isn't holding, re-send the current line. Advancement
     * happens in _handleMotionComplete on 0xA1 'B' acks.
     */
    _startStreamPump() {
        if (this._streamPumpInterval) clearInterval(this._streamPumpInterval);
        const MAX_PASSES = 200;          // safety bound — vendor pcap used ~87
        const LINES_PER_TICK = 4;        // batch sends to hit 250 lines/sec
                                          // on Windows where setInterval's
                                          // effective minimum is ~16 ms.
        this._streamPumpInterval = setInterval(() => {
            if (!this._running || this._paused || this._boardHolding) return;
            for (let i = 0; i < LINES_PER_TICK; i++) {
                if (!this._running || this._paused || this._boardHolding) return;
                const lineNum = this._gcodeIndex + 1;
                const code = this._gcodeLines[this._gcodeIndex];
                this._sendStreamLine(lineNum, code);
                this._gcodeIndex++;
                if (this._gcodeIndex >= this._gcodeLines.length) {
                    this._gcodeIndex = 0;
                    this._streamPassCount++;
                    logger.info(`[RTS] Stream pass ${this._streamPassCount} complete — executed ${this._executedCount}/${this._gcodeLines.length}`);
                    if (this._streamPassCount >= MAX_PASSES) {
                        logger.warn(`[RTS] Stream pump hit ${MAX_PASSES}-pass safety bound with ${this._executedCount}/${this._gcodeLines.length} executed. Stopping.`);
                        this._stopStreamPump();
                        this._running = false;
                        this.emit('sender:end');
                        this.emit('workflow:state', 'idle');
                        return;
                    }
                }
            }
        }, 5);
    }

    _stopStreamPump() {
        if (this._streamPumpInterval) {
            clearInterval(this._streamPumpInterval);
            this._streamPumpInterval = null;
        }
    }

    /**
     * Emit a sender:status event so the frontend's progress counter advances.
     */
    _emitSenderStatus() {
        const elapsed = Date.now() - (this._jobStartTime || Date.now());
        const total = this._gcodeLines.length;
        // Real progress = executed count (from 'B' acks), not raw send pointer
        // which wraps around in the loop-back pump.
        const executed = this._executedCount;
        const rate = executed > 0 && elapsed > 0 ? executed / (elapsed / 1000) : 0;
        const remaining = rate > 0 ? ((total - executed) / rate) * 1000 : 0;
        this.emit('sender:status', {
            sent: executed,
            total,
            received: executed,
            startedAt: this._jobStartTime,
            elapsedTime: elapsed,
            remainingTime: remaining || 0,
        });
    }

    /**
     * Handle motor error status frame (0xBE).
     * Format: 01 05 BE XX FF — XX = bitmask of motors in error
     *   bit 0 = X motor, bit 1 = Y1 motor, bit 2 = Y2 motor, bit 3 = Z motor
     */
    _handleMotorErrorStatus(frame) {
        if (frame.length < 5) return;
        const errorMask = frame[3];
        const errors = [];
        if (errorMask & 0x01) errors.push('X');
        if (errorMask & 0x02) errors.push('Y1');
        if (errorMask & 0x04) errors.push('Y2');
        if (errorMask & 0x08) errors.push('Z');

        if (errors.length > 0) {
            this.emit('console', `⚠️ Motor errors: ${errors.join(', ')}`);
            this.emit('motor:errors', { mask: errorMask, motors: errors });
        } else if (this._activeState === 'MotorError') {
            this.emit('console', '✅ All motor errors cleared');
            this.emit('motor:errors', { mask: 0, motors: [] });
        }

        logger.info(`[RTS] Motor error status: 0x${errorMask.toString(16)} = ${errors.length > 0 ? errors.join('+') : 'clear'}`);
    }

    /**
     * Per-line ack from the board during job streaming.
     * Fires for both 0xA2 (counter) and 0xA6 (text echo). Either one means
     * the board has consumed one line from its input queue — pump the next.
     * This replaces the status-frame-driven pump for streaming, which was
     * pushing 11× faster than the board could process.
     *
     * To avoid double-pumping when both 0xA2 and 0xA6 fire ~1 ms apart for
     * the same line, we coalesce on the line number. The 0xA2 payload byte 1
     * holds the line counter low-byte; the 0xA6 payload contains "N<digits>".
     *
     * @param {Buffer} frame
     * @param {number} cmdByte - 0xA2 or 0xA6
     */
    _handleLineAck(frame, cmdByte) {
        logger.debug(`[RTS LINE-ACK] cmd=0x${cmdByte.toString(16)} frame=${frame.toString('hex')} idx=${this._gcodeIndex}/${this._gcodeLines.length}`);

        // ─── Streaming-stall fix (Tawfiq msg 6965, 2026-06-25) ──────
        // Stage 15 disabled this path because of 11× overrun. The actual
        // overrun came from NON-MONOTONIC dedup — comparing lineNum to
        // ONLY the previous one. If acks arrive as (1,2,1,2) the dedup
        // misses every other one and pumps the next line twice.
        //
        // Fix: MONOTONIC dedup — only advance when lineNum is strictly
        // greater than the highest line we've advanced past. So
        // duplicate acks for an old line are ignored, and the stream
        // moves forward exactly once per unique line.
        //
        // This re-enables 0xA2/0xA6 as a fallback path for lines that
        // don't produce 0xA1 — which is the bug for multi-shape jobs
        // with per-segment G21/G90 modal-set re-declarations.
        if (!this._running || this._paused || this._boardHolding) return;

        let lineNum = null;
        if (cmdByte === RESP_LINE_COUNTER && frame.length >= 8) {
            lineNum = frame[4] | (frame[5] << 8) | (frame[6] << 16) | (frame[7] << 24);
        } else if (cmdByte === RESP_LINE_ECHO && frame.length >= 6) {
            let i = 4;
            let digits = '';
            while (i < frame.length - 1 && frame[i] >= 0x30 && frame[i] <= 0x39) {
                digits += String.fromCharCode(frame[i]);
                i++;
            }
            if (digits) lineNum = parseInt(digits, 10);
        }
        if (lineNum === null) return;  // Unparseable — ignore (no false advance)

        // Initialize lastAckedLine to 0 if first time
        if (this._lastAckedLine === null) this._lastAckedLine = 0;

        // Monotonic gate: only advance for a NEW line, never a duplicate.
        if (lineNum <= this._lastAckedLine) return;
        this._lastAckedLine = lineNum;

        // Real ack — cancel any pending safety timeout for this line.
        this._clearAckTimeout();
        this._acceptedCount++;
        this._emitSenderStatus();
        this._sendNextGcodeLine();
    }

    // ─── JSON Message Handlers ──────────────────────────────────────────

    /**
     * Handle a settings JSON message.
     * @param {object} msg - {msgType: "settings", parameter: "...", value: ...}
     */
    _handleSettingMsg(msg) {
        const param = msg.parameter;
        const value = msg.value;

        if (param === 'settings_end') {
            logger.info('[RTS] Settings dump complete');
            this.emit('settings', this._settings);
            return;
        }

        this._settings[param] = value;

        // Extract specific useful settings and update firmware config
        if (param === 'serial_num') {
            this._serialNumber = String(value);
        } else if (param === 'steps' && Array.isArray(value)) {
            this._firmwareConfig.steps_per_mm = value.slice(0, 4);
            logger.info(`[RTS] Steps/mm: ${value}`);
        } else if (param === 'max_v' && Array.isArray(value)) {
            this._firmwareConfig.max_velocity = value.slice(0, 4);
            logger.info(`[RTS] Max velocity: ${value}`);
        } else if (param === 'accel' && Array.isArray(value)) {
            this._firmwareConfig.accel = value.slice(0, 4);
        } else if (param === 'min_travel' && Array.isArray(value)) {
            this._firmwareConfig.min_travel = value.slice(0, 4);
        } else if (param === 'max_travel' && Array.isArray(value)) {
            this._firmwareConfig.max_travel = value.slice(0, 4);
        } else if (param === 'inverted' && Array.isArray(value)) {
            const boardInverted = value.slice(0, 4).map(v => !!v);
            logger.info(`[RTS] Board reports inverted: ${JSON.stringify(boardInverted)} (jog uses hardcoded direction map)`);
            // NOTE: We do NOT override _firmwareConfig.inverted from board settings.
            // The board's inverted flag controls firmware-internal G-code processing,
            // but CMD_JOG (0x20) raw velocity bypasses that — so we use our own
            // hardcoded direction map for jog. See JOG_DIRECTION_MAP constant.
        }

        // Emit individual setting for frontend
        this.emit('settings', { [param]: value });
    }

    /**
     * Handle work coordinate offset JSON message.
     * @param {object} msg - {msgType: "offsets", index: N, value: [x,y,z,a]}
     */
    _handleOffsetsMsg(msg) {
        if (msg.index !== undefined && Array.isArray(msg.value)) {
            const [x, y, z, a] = msg.value;
            this._offsets[msg.index] = { x, y, z, a };

            // If this is G54 (index 0), update the active WCO
            // (Default assumption - the board starts in G54)
            if (msg.index === 0) {
                this._wco = { x: x || 0, y: y || 0, z: z || 0, a: a || 0 };
                this._emitWcsHealth();
            }

            this.emit('parameters', {
                type: `G${54 + msg.index}`,
                value: { x, y, z, a },
            });
        }
    }

    /**
     * ECSS Module 2 — WCS Health Monitor.
     * Inspects the active WCO and flags suspicious offsets that almost
     * certainly indicate NVRAM corruption from a prior session (e.g. the
     * -137.430 mm Z offset incident on 2026-05-14).
     */
    _emitWcsHealth() {
        const THRESHOLD = 50; // mm — any axis offset beyond ±50 mm is suspect.
        const axes = ['x', 'y', 'z'];
        const flagged = axes
            .map(a => ({ axis: a.toUpperCase(), value: Math.round((this._wco[a] || 0) * 1000) / 1000 }))
            .filter(a => Math.abs(a.value) > THRESHOLD);
        const healthy = flagged.length === 0;
        this.emit('safety:wcsHealth', {
            healthy,
            wco: { ...this._wco },
            flagged,
            threshold: THRESHOLD,
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Binary Frame Builders
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Build and write a binary frame.
     * @param {Buffer|number[]} payload - Bytes between start/length and end byte
     * @returns {Buffer} The complete frame
     */
    _writeFrame(payload) {
        const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        // Total length = 1 (start) + 1 (length) + payload + 1 (end)
        const totalLen = payloadBuf.length + 3;
        const frame = Buffer.alloc(totalLen);

        frame[0] = FRAME_START;
        frame[1] = totalLen;
        payloadBuf.copy(frame, 2);
        frame[totalLen - 1] = FRAME_END;

        if (this.connection) {
            this._enqueueWrite(frame);
        } else {
            logger.warn('[RTS] Cannot write frame - no connection');
        }

        return frame;
    }

    /**
     * Enqueue a raw buffer for serialized writing.
     * Prevents concurrent writes that corrupt the USB serial stream.
     */
    _enqueueWrite(data) {
        this._writeQueue.push(data);
        if (!this._writing) {
            this._drainQueue();
        }
    }

    /**
     * Drain the write queue one frame at a time.
     * Waits for the serial port 'drain' event before sending the next frame.
     */
    _drainQueue() {
        if (this._writeQueue.length === 0) {
            this._writing = false;
            return;
        }
        this._writing = true;
        const data = this._writeQueue.shift();
        if (!this.connection || !this.connection.isOpen) {
            this._writing = false;
            this._writeQueue = [];
            return;
        }
        try {
            this.connection.writeRaw(data);
            logger.debug(`[RTS TX] ${data.toString('hex')}`);
            // Use setImmediate to yield to event loop between writes
            // This prevents flooding the USB buffer
            setImmediate(() => this._drainQueue());
        } catch (err) {
            logger.error(`[RTS] Write error: ${err.message}`);
            this._writing = false;
            this._writeQueue = [];
        }
    }

    /**
     * Send a 5-byte query frame: 01 05 00 XX FF
     * @param {number} register - Register ID to query
     */
    _sendQueryFrame(register) {
        this._writeFrame(Buffer.from([CMD_QUERY, register]));
    }

    /**
     * Send a register write frame: 01 0B 00 82 XX YY VV VV VV VV FF
     * @param {number} register - Register to write
     * @param {number} axis - Axis index (0-3) or sub-register
     * @param {number} value - Value to write (float32 or uint32)
     * @param {boolean} [isFloat=true] - Whether value is float32 or uint32
     */
    _sendWriteRegister(register, axis, value, isFloat = true) {
        const payload = Buffer.alloc(8);
        payload[0] = CMD_QUERY;  // 0x00
        payload[1] = CMD_WRITE_REG; // 0x82
        payload[2] = register;
        payload[3] = axis;
        if (isFloat) {
            payload.writeFloatLE(value, 4);
        } else {
            payload.writeUInt32LE(value >>> 0, 4);
        }
        this._writeFrame(payload);
    }

    /**
     * Build a 25-byte jog frame.
     * Format: 01 19 00 20 [X_vel_f32] [Y_vel_f32] [Z_vel_f32] [A_vel_f32] [4_zero_bytes] FF
     * @param {number} vx - X velocity (-1.0 to 1.0 or higher for fast jog)
     * @param {number} vy - Y velocity
     * @param {number} vz - Z velocity
     * @param {number} va - A velocity
     */
    _sendJogFrame(vx, vy, vz, va, feedRate = 2000) {
        const payload = Buffer.alloc(22); // 00 20 + 4*4 floats + feedRate float = 22
        payload[0] = CMD_QUERY;  // 0x00
        payload[1] = CMD_JOG;   // 0x20
        payload.writeFloatLE(vx, 2);
        payload.writeFloatLE(vy, 6);
        payload.writeFloatLE(vz, 10);
        payload.writeFloatLE(va, 14);
        // Last 4 bytes = feed rate (from Wireshark: RTS-X sends 2000.0 here)
        payload.writeFloatLE(feedRate, 18);
        this._writeFrame(payload);
    }

    /**
     * Send a G-code mode command.
     * Format: 01 09 00 40 3E [ASCII bytes] FF
     * The 3E byte ('>') prefixes the G-code string.
     * @param {string} gcode - G-code string (e.g., "G54", "G21")
     */
    _sendGcodeMode(gcode) {
        const asciiBytes = Buffer.from(gcode, 'ascii');
        const payload = Buffer.alloc(3 + asciiBytes.length);
        payload[0] = CMD_QUERY;      // 0x00
        payload[1] = CMD_GCODE_MODE; // 0x40
        payload[2] = 0x3E;           // '>'
        asciiBytes.copy(payload, 3);
        this._writeFrame(payload);
    }

    /**
     * Send a numbered G-code stream line — the format the RTS firmware
     * actually accepts during job streaming. Decoded from a 159 s USBPcap
     * capture of the factory streamer (2026-05-13):
     *   Frame: 01 LL 00 "AN<lineNum><gcode>" FF
     *   e.g.  01 1E 00 "AN6G1X22.318Y10.433Z-0.100F200.0" FF
     * The 0x00 byte is CMD_QUERY; the ASCII "AN" prefix tells the firmware
     * "Add Numbered line". Plain ASCII (the old _sendGcode path) is silently
     * ignored by the firmware during streaming — that's the reason Start
     * "did nothing" pre-Stage-4.
     * @param {number} lineNum - 1-based line number
     * @param {string} code - G-code text, no trailing newline
     */
    _sendStreamLine(lineNum, code) {
        // Strip inner whitespace — the vendor capture shows lines as
        // "AN6G1X22.318Y10.433Z-0.100F200.0" (no inner spaces), but
        // typical CAM output ("G1 X22.318 Y10.433 Z-0.100 F200.0") has
        // spaces. RTS firmware appears strict about this — keep parity
        // with the vendor wire format.
        const compact = String(code).replace(/\s+/g, '');
        const text = `AN${lineNum}${compact}`;
        const asciiBytes = Buffer.from(text, 'ascii');
        const payload = Buffer.alloc(1 + asciiBytes.length);
        payload[0] = CMD_QUERY; // 0x00
        asciiBytes.copy(payload, 1);
        logger.info(`[RTS TX STREAM] ${text}`);
        this._writeFrame(payload);

        // ─── Streaming-stall fix (Tawfiq msg 6965, 2026-06-25) ──────
        // Stage 25 advances ONLY on 0xA1 'A'/'B'. Those don't fire for
        // modal-set lines (G21, G90, F-only, etc.) — so multi-shape jobs
        // stall at the per-segment G21/G90 re-declarations Vectric / CAM
        // posts use. Symptom: only the first shape carves (C of "CNC",
        // the square of "T_STAR_square.nc"), then silence.
        //
        // Fix: arm a 500ms safety timer after each TX. If no ack of ANY
        // kind clears it (0xA1 'A'/'B' OR 0xA2/0xA6 monotonic line#),
        // the timer fires and advances anyway. Real ack races the timer
        // 99% of the time so this stays ack-driven in the happy path.
        this._armAckTimeout(lineNum);
    }

    /**
     * Arm the safety timeout that advances the stream if no ack arrives.
     * Cancels any previous pending timer. The timeout warns + advances
     * so silent stalls become loud + recoverable.
     *
     * @param {number} lineNum  the 1-based line we just sent (for diag log)
     */
    _armAckTimeout(lineNum) {
        if (this._ackTimer) clearTimeout(this._ackTimer);
        this._lastSentLineNum = lineNum;
        this._ackTimer = setTimeout(() => {
            this._ackTimer = null;
            // Only advance if still streaming + state allows
            if (!this._running || this._paused || this._boardHolding) return;
            // Only advance if we haven't already moved past this line
            if (this._gcodeIndex > lineNum) return;
            logger.warn(`[RTS] ack-timeout on line ${lineNum} after 500ms ` +
                `— modal-set line likely (no 0xA1 fires for G21/G90/F-only). ` +
                `Advancing to next line.`);
            this._acceptedCount++;
            this._emitSenderStatus();
            this._sendNextGcodeLine();
        }, 500);
    }

    /**
     * Clear the safety timeout. Called when ANY recognised ack arrives.
     */
    _clearAckTimeout() {
        if (this._ackTimer) {
            clearTimeout(this._ackTimer);
            this._ackTimer = null;
        }
    }

    /**
     * Tell the firmware to enter streaming mode — MUST be sent before the
     * first AN frame, otherwise the firmware reads AN bytes but never
     * queues them as a runnable job (and never emits the 0xA1 "A" ack).
     *
     * Decoded from vendor source 2026-05-13:
     *   CommPort.sdStartStreaming → bytearray([152]) → _transmit
     *   = frame  01 05 00 98 FF
     */
    _sendStartStreaming() {
        logger.info('[RTS TX STREAM] CMD 0x98 (sdStartStreaming)');
        this._writeFrame(Buffer.from([CMD_QUERY, 0x98]));
    }

    /**
     * Tell the firmware to exit any active SysMode (Homing/Probing/Jog/
     * ToolSet/ToolChange) and return to GENERAL mode. Vendor source:
     *   CommPort.sysModeExit → bytearray([11]) → _transmit
     *   = frame  01 05 00 0B FF
     *
     * The 2026-05-13 12:26 test had the board reporting state byte 0x05
     * (Jog) for every status frame across the entire run, never moving
     * past it. Most likely cause: a prior jog left the board in
     * SysMode=JOG_DISTANCE (also numeric value 5). AN frames sent in
     * that mode get partial/incorrect execution, which matches the
     * "moves and performs some, doesn't complete" symptom.
     */
    _sendSysModeExit() {
        logger.info('[RTS TX] CMD 0x0B (sysModeExit) — return to GENERAL mode');
        this._writeFrame(Buffer.from([CMD_QUERY, 0x0B]));
    }

    /**
     * Write raw ASCII data (no binary framing).
     * Used for GRBL commands like $I, $H, etc.
     * @param {string} data
     */
    _writeAscii(data) {
        if (!this.connection) return;
        const buf = Buffer.from(data, 'ascii');
        this.connection.writeRaw(buf);
        logger.debug(`[RTS TX ASCII] ${data.trim()}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Status Polling
    // ═══════════════════════════════════════════════════════════════════════

    _startPolling() {
        this._stopPolling();
        this._pollTimer = setInterval(() => {
            // Skip polling while jogging to prevent concurrent writes
            if (this._jogActive) return;
            this._sendQueryFrame(REG_STATUS);
        }, STATUS_POLL_INTERVAL);
        logger.info('[RTS] Status polling started at 10Hz');
    }

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Public API (CNCEngine-compatible interface)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Command dispatcher - same interface as GrblController.
     * @param {string} cmd - Command name
     * @param {...*} args - Command arguments
     */
    command(cmd, ...args) {
        const handler = this._commands[cmd];
        if (handler) {
            handler.call(this, ...args);
        } else {
            logger.warn(`[RTS] Unknown command: "${cmd}"`);
        }
    }

    get _commands() {
        return {
            // G-code streaming
            'gcode': (code) => this._sendGcode(code),
            'gcode:load': (name, gcode) => this._loadGcode(name, gcode),
            'gcode:start': () => this._startJob(0),
            'gcode:startFromLine': (line) => this._startJob(line),
            'gcode:pause': () => this._pauseJob(),
            'gcode:resume': () => this._resumeJob(),
            'gcode:stop': () => this._stopJob(),
            'gcode:unload': () => this._unloadGcode(),

            // Realtime commands
            'feedhold': () => this._feedHold(),
            'cyclestart': () => this._cycleStart(),
            'reset': () => this._softReset(),
            'jogcancel': () => this._jogCancel(),

            // Machine control
            'homing': () => this._home(),
            'homing:X': () => this._homeAxis('X'),
            'homing:Y': () => this._homeAxis('Y'),
            'homing:Z': () => this._homeAxis('Z'),
            'homing:A': () => this._homeAxis('A'),
            'unlock': () => this._unlock(),
            'motor:reset': (axis) => this._motorReset(axis),
            'motor:resetAll': () => this._motorResetAll(),
            'jog': (params) => this._jog(params),
            'jog:safe': (params) => this._jog(params),
            'move': (params) => this._move(params),

            // Probing
            'probe:z': (params) => this._probeZ(params),

            // Info requests
            'settings': () => this._requestSettings(),
            'buildinfo': () => this._requestBuildInfo(),
            'statusreport': () => this._sendQueryFrame(REG_STATUS),
            'parserstate': () => this._getParserState(),
            'workcoordinates': () => this._getWorkCoordinates(),
            'checkmode': () => this._checkMode(),

            // Raw data
            'raw': (data) => this._sendRaw(data),

            // Overrides
            'feedOverride:reset': () => { this._overrides.feed = 100; },
            'feedOverride:coarsePlus': () => { this._overrides.feed = Math.min(200, this._overrides.feed + 10); },
            'feedOverride:coarseMinus': () => { this._overrides.feed = Math.max(10, this._overrides.feed - 10); },
            'feedOverride:finePlus': () => { this._overrides.feed = Math.min(200, this._overrides.feed + 1); },
            'feedOverride:fineMinus': () => { this._overrides.feed = Math.max(10, this._overrides.feed - 1); },
            'spindleOverride:reset': () => { this._overrides.spindle = 100; },
            'spindleOverride:coarsePlus': () => { this._overrides.spindle = Math.min(200, this._overrides.spindle + 10); },
            'spindleOverride:coarseMinus': () => { this._overrides.spindle = Math.max(10, this._overrides.spindle - 10); },

            // E-stop
            'estop': () => this._estop(),
            'estop:clear': () => this._clearEstop(),

            // Limit switch / travel error clear
            'limit:clear': () => this._clearLimitError(),

            // Macros
            'macro:run': (content) => this._sendGcode(content),

            // WCS
            'wcs:set': (wcs) => this._setWCS(wcs),
            'wcs:zero': (params) => this._zeroWCS(params),
            'wcs:zeroAll': () => this._zeroAll(),

            // Triggers (no-op stubs)
            'trigger:set': () => {},
            'trigger:loadAll': () => {},

            // Debug (no-op stubs)
            'debug:enable': () => {},
            'debug:disable': () => {},
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Motion Commands
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Send a jog command using position-monitored binary velocity jog.
     *
     * The frontend sends distance-based params (e.g. x=1 means move 1mm).
     * Uses firmware-mapped velocity scaling:
     *   - feedRate (mm/min) is scaled relative to firmware max_velocity
     *   - RTS velocity unit maps to firmware's internal speed scale
     *   - Position monitoring via B0 status frames (10Hz) for distance control
     *
     * Velocity scaling (from firmware config):
     *   feedRate 1000 mm/min on X (max 15240) → vel = 1000/15240 * 254 ≈ 16.7
     *   Small step sizes use lower velocities for accuracy
     *
     * @param {object} params - {x, y, z, a, feedRate}
     */
    _jog(params = {}) {
        const { x = 0, y = 0, z = 0, a = 0, feedRate = 1000 } = params;

        if (x === 0 && y === 0 && z === 0 && a === 0) return;

        // Cancel any active jog
        this._cancelActiveJog();

        // Velocity scaling from firmware config
        const maxVel = this._firmwareConfig.max_velocity;
        const computeVel = (dist, axisIdx) => {
            if (dist === 0) return 0;
            const axisMax = maxVel[axisIdx] || 15240;
            const scaled = (feedRate / axisMax) * 254;
            const distFactor = Math.abs(dist) < 1 ? Math.max(0.3, Math.abs(dist)) : 1;
            const vel = Math.max(1, Math.min(scaled * distFactor, 500));
            return Math.sign(dist) * vel;
        };

        let vx = computeVel(x, 0);
        let vy = computeVel(y, 1);
        let vz = computeVel(z, 2);
        let va = computeVel(a, 3);

        // Apply hardcoded jog direction (CMD 0x20 bypasses firmware inversion)
        vx *= JOG_DIRECTION[0];
        vy *= JOG_DIRECTION[1];
        vz *= JOG_DIRECTION[2];
        va *= JOG_DIRECTION[3];

        // Calculate duration based on distance and feedRate
        const maxDist = Math.max(Math.abs(x), Math.abs(y), Math.abs(z), Math.abs(a));
        const durationMs = Math.max(100, (maxDist / (feedRate / 60000)));

        logger.info(`[RTS] Jog step: dist=${maxDist}mm feedRate=${feedRate}mm/min vel=[${vx.toFixed(1)},${vy.toFixed(1)},${vz.toFixed(1)},${va.toFixed(1)}] duration=${durationMs.toFixed(0)}ms`);

        try {
            // Suppress status polling during jog to prevent concurrent writes
            this._jogActive = true;

            // === RTS-X Jog Protocol (from Wireshark capture) ===
            // Step 1: Enable jog mode (CMD 0x10 val=0x01)
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_JOG_MODE, 0x01]));

            // Step 2: Send velocity jog frame with feedRate
            this._sendJogFrame(vx, vy, vz, va, feedRate);

            // Step 3: Stop after calculated duration
            this._jogStopTimer = setTimeout(() => {
                try {
                    // Send zero velocity
                    this._sendJogFrame(0, 0, 0, 0, feedRate);
                    // Disable jog mode (CMD 0x10 val=0x00)
                    this._writeFrame(Buffer.from([CMD_QUERY, CMD_JOG_MODE, 0x00]));
                    this._jogActive = false;
                    logger.info('[RTS] Jog step complete — velocity zeroed, jog mode disabled');
                } catch (err) {
                    logger.error(`[RTS] Error stopping jog: ${err.message}`);
                    this._jogActive = false;
                }
            }, durationMs);
        } catch (err) {
            logger.error(`[RTS] Error starting jog: ${err.message}`);
            this._jogActive = false;
        }
    }

    /**
     * Check if active jog has reached target distance.
     * Called from _handleStatusFrame on each B0 position update (10Hz).
     * (Kept for continuous jog support, not needed for step jog)
     */
    _checkJogTarget() {
        if (!this._jogTarget) return;

        const t = this._jogTarget;
        const movedX = Math.abs(this._mpos.x - t.startX);
        const movedY = Math.abs(this._mpos.y - t.startY);
        const movedZ = Math.abs(this._mpos.z - t.startZ);
        const movedA = Math.abs(this._mpos.a - t.startA);

        const xDone = t.distX === 0 || movedX >= t.distX;
        const yDone = t.distY === 0 || movedY >= t.distY;
        const zDone = t.distZ === 0 || movedZ >= t.distZ;
        const aDone = t.distA === 0 || movedA >= t.distA;

        if (xDone && yDone && zDone && aDone) {
            logger.info(`[RTS] Jog target reached: moved X=${movedX.toFixed(2)} Y=${movedY.toFixed(2)} Z=${movedZ.toFixed(2)}`);
            this._cancelActiveJog();
        }
    }

    /**
     * Cancel active jog — send zero velocity and clear tracking.
     */
    _cancelActiveJog() {
        if (this._jogStopTimer) {
            clearTimeout(this._jogStopTimer);
            this._jogStopTimer = null;
        }
        // Always send zero velocity + disable jog mode to ensure clean stop
        this._sendJogFrame(0, 0, 0, 0);
        this._writeFrame(Buffer.from([CMD_QUERY, CMD_JOG_MODE, 0x00]));
        this._jogTarget = null;
        this._jogActive = false;
    }

    /**
     * Cancel active jog (send zero velocity + disable jog mode).
     */
    _jogCancel() {
        this._cancelActiveJog();
    }

    /**
     * Home all axes sequentially (Z → X → Y per safety convention).
     *
     * From Wireshark capture of RTS-X software:
     *   1. Send homing command: 01 06 00 0A 01 FF (twice)
     *   2. Board enters homing state (state=0x08, flags=0x01)
     *   3. After ~400ms, send CMD 0x10 val=0x00, then a MOVE frame
     *      to drive the axis toward its limit switch
     *   4. Board moves until switch triggers → zeros position → returns to idle
     *   5. Repeat for next axis
     *
     * The host MUST send the seek move — the board won't move on its own.
     */
    _home() {
        logger.info('[RTS] Starting auto-home (all axes) — sequential Z→X→Y');
        this._homing = true;
        this._homingAxis = null;
        this._activeState = 'Home';
        this._updateStateObject();
        this.emit('state', this.getState());
        this.emit('homing:location', { location: 'all', status: 'started', sequence: ['Z', 'X', 'Y'] });
        this.emit('console', '[RTS] Homing all axes (Z → X → Y)...');

        // Safety: Z FIRST so the bit lifts up before X/Y motion drags it
        // through any clamps or workpiece. Standard CNC convention.
        this._homingQueue = ['Z', 'X', 'Y'];
        this._startNextAxisHome();
    }

    /**
     * Home a single axis.
     * @param {string} axis - 'X', 'Y', 'Z', or 'A'
     */
    _homeAxis(axis) {
        const axisUpper = String(axis).toUpperCase();
        if (!['X', 'Y', 'Z', 'A'].includes(axisUpper)) {
            logger.warn(`[RTS] Invalid home axis: ${axis}`);
            return;
        }
        logger.info(`[RTS] Starting auto-home (${axisUpper} axis)`);
        this._homing = true;
        this._homingAxis = axisUpper;
        this._activeState = 'Home';
        this._updateStateObject();
        this.emit('state', this.getState());
        this.emit('homing:location', { location: axisUpper, status: 'started' });
        this.emit('console', `[RTS] Homing ${axisUpper} axis...`);

        this._homingQueue = [axisUpper];
        this._startNextAxisHome();
    }

    /**
     * Start homing the next axis in the queue.
     * Matches RTS-X EXACTLY from live stream (March 26, 2026):
     *
     *   1. HOMING TRIGGER (0x0A, twice)
     *   2. Query HOME_STATUS (0xBF)
     *   3. SET_MODE (0x10, value=axis_index: X=0, Y=1, Z=2)
     *   4. Fast seek jog toward switch (811 mm/min, feed=2000)
     *   5. Wait for switch trigger (state→Idle)
     *   6. Back-off (+5 mm/min, feed=0)
     *   7. SET_MODE again
     *   8. Slow seek (-15 mm/min, feed=200)
     *   9. SET_HOME (0x0B) to zero position
     *
     * NO test jogs — RTS-X doesn't send them.
     * SET_MODE value = axis index (X=0, Y=1, Z=2), NOT always 1.
     */
    _startNextAxisHome() {
        if (!this._homingQueue || this._homingQueue.length === 0) {
            this._onHomingComplete();
            return;
        }

        const axis = this._homingQueue.shift();
        this._homingAxis = axis;
        this._homingPhase = 'homing_trigger';
        const axisIdx = { X: 0, Y: 1, Z: 2, A: 3 }[axis];
        const direction = HOME_DIRECTION[axisIdx];

        logger.info(`[RTS] Homing ${axis} — SET_MODE=${axisIdx}, dir=${direction > 0 ? '+' : '-'}`);
        this.emit('console', `[RTS] Homing ${axis} axis...`);
        // Tell the frontend which axis is currently running so the homing
        // overlay can highlight the right step without dismissing the modal.
        this.emit('homing:axis', { axis, remaining: [...this._homingQueue] });

        // Store for later phases
        this._homingAxisIdx = axisIdx;
        this._homingDirection = direction;

        // Pre-step: clear closed-loop error on ALL 4 motors before each axis.
        // Reported by Tawfiq msg 6728 (capture): manual X/Y jogs done right
        // before Home All leave residual closed-loop drift on those motors.
        // Clearing only the axis-being-homed motor (Z first) wasn't enough —
        // X+Y motors still tripped ALARM 9 ~1s into Z homing because they
        // carried drift from the prior jog. Clearing all 4 motors flushes
        // everything, so Home All runs in a single go without manual reset.
        for (const motorIdx of [MOTOR_INDEX.X, MOTOR_INDEX.Y1, MOTOR_INDEX.Y2, MOTOR_INDEX.Z]) {
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, motorIdx]));
        }
        logger.info(`[RTS] Pre-homing motor-clear (all 4 motors) before ${axis}`);
        this._motorResetTime = Date.now(); // arm the 3-sec grace period

        // Wait 500ms (was 200ms) for all 4 motor-clears to fully propagate.
        setTimeout(() => {
            if (!this._homing) return;

            // Step 1: HOMING TRIGGER (twice) — exact: 01 06 00 0A 01 FF
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_HOME, 0x01]));
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_HOME, 0x01]));
        }, 500);

        // Step 2: Query home status — exact: 01 05 00 BF FF
        // Offset +200ms (was 100ms) so it fires AFTER the motor-clear pre-step + HOMING_TRIGGER.
        setTimeout(() => {
            if (!this._homing) return;
            this._writeFrame(Buffer.from([CMD_QUERY, 0xBF]));
        }, 600);

        // Step 3: SET_MODE + fast seek with vendor-exact floats.
        // Offset to 900ms = motor-clear (500) + 300ms gap after Step 2 (600).
        setTimeout(() => {
            if (!this._homing) return;
            this._homingPhase = 'fast_seek';

            // SET_MODE value = axis index (X=0, Y=1, Z=2) — exact from vendor pcap.
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_JOG_MODE, axisIdx]));

            // Fast seek 0x20 frame — byte-perfect from vendor pcap. Earlier
            // versions used computed velocity values; vendor sends fixed
            // position+feed vectors and that's what the firmware actually
            // homes to (165 mm Z, -811 mm X/Y, feed 2000).
            const vec = HOMING_VECTORS[axis]?.fast;
            if (vec) {
                this._sendJogFrame(vec[0], vec[1], vec[2], vec[3], vec[4]);
                this.emit('console', `[RTS] ${axis}: fast seek toward switch (vendor vec)...`);
            } else {
                logger.warn(`[RTS] No homing vector for axis ${axis} — using fallback`);
            }
        }, 900);

        // Per-axis timeout — vendor completes each axis in 4–8 sec, so 12 sec
        // is enough headroom while still failing fast if a switch is dead.
        if (this._homingTimer) clearTimeout(this._homingTimer);
        this._homingTimer = setTimeout(() => {
            if (this._homing) {
                this._homing = false;
                this._homingAxis = null;
                this._homingPhase = null;
                this._homingQueue = [];
                logger.error(`[RTS] Homing timeout on ${axis} — check limit switches`);
                this.emit('alarm', { code: 0x03, message: `Homing timeout on ${axis} — check limit switches are connected and working` });
                this.emit('console', `[RTS] HOMING TIMEOUT on ${axis} — limit switch not triggered. Check wiring.`);
                this.emit('homing:location', { location: axis, status: 'failed' });
            }
        }, HOMING_AXIS_TIMEOUT_MS);
    }

    /**
     * Phase 2: Send HOMING command + Phase 3: Fast seek
     * Decoded from Y-homing capture: HOME 0x0A (twice) → wait 400ms → SET_MODE + fast jog
     */
    // _startHomingPhase2 removed — integrated into _startNextAxisHome for cleaner flow

    /**
     * Phase 5-7: Back-off, slow re-approach, set home.
     * Called when fast seek completes (state transitions from Homing to Idle,
     * meaning the limit switch was triggered and the board stopped).
     */
    _startHomingBackoff() {
        if (!this._homing) return;
        const axis = this._homingAxis;
        const axisIdx = this._homingAxisIdx;
        const isLastAxis = !this._homingQueue || this._homingQueue.length === 0;
        const vectors = HOMING_VECTORS[axis];

        // ── Phase 5: back off from switch with vendor-exact float vector ──
        this._homingPhase = 'backoff';
        this.emit('console', `[RTS] ${axis}: backing off...`);

        // Query home status first (exact: 01 05 00 BF FF)
        this._writeFrame(Buffer.from([CMD_QUERY, 0xBF]));

        // Send back-off vector after 20 ms settle (was 100ms — Tawfiq msg 6785
        // reported visible delay between fast-seek hit and back-off start).
        // SET_MODE before back-off: Z ONLY. Z's firmware needs it (msg 6744:
        // without SET_MODE Z back-off JOG was silently ignored). X/Y/A don't
        // need it — adding SET_MODE there malformed their transition (msg 6776).
        setTimeout(() => {
            if (!this._homing) return;
            if (!vectors) return;
            if (axis === 'Z') {
                this._writeFrame(Buffer.from([CMD_QUERY, CMD_JOG_MODE, axisIdx]));
            }
            const v = vectors.backoff;
            this._sendJogFrame(v[0], v[1], v[2], v[3], v[4]);
        }, 20);

        // ── Wait for back-off complete, then slow re-approach ──
        // Same _awaitMotionComplete pattern as X / Y (Tawfiq's "make
        // it similar to X / Y" directive). The per-phase timeouts in
        // _awaitMotionComplete (5 sec for backoff) handle a late 'E'.
        this._awaitMotionComplete(() => {
            if (!this._homing) return;
            this._homingPhase = 'slow_seek';
            this.emit('console', `[RTS] ${axis}: precise homing...`);

            // Query home status
            this._writeFrame(Buffer.from([CMD_QUERY, 0xBF]));

            // SET_MODE = axis index — same byte as fast-seek phase.
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_JOG_MODE, axisIdx]));

            // Slow re-approach 0x20 — vendor-exact float vector.
            if (vectors) {
                const v = vectors.slow;
                this._sendJogFrame(v[0], v[1], v[2], v[3], v[4]);
            }

            // ── Wait for switch trigger, then advance / set home ──
            this._awaitMotionComplete(() => {
                if (!this._homing) return;

                // SET_HOME (0x0B) is sent ONLY ONCE per Home All, after the
                // LAST axis completes. Vendor pcap shows a single 0x0B at the
                // end of the Z → X → Y sequence — not one per axis. Sending
                // it after each axis was zeroing partially-homed positions.
                if (isLastAxis) {
                    this._homingPhase = 'set_home';
                    this._writeFrame(Buffer.from([CMD_QUERY, 0xBF]));
                    setTimeout(() => {
                        if (!this._homing) return;
                        this._writeFrame(Buffer.from([CMD_QUERY, CMD_SET_HOME]));
                        this.emit('console', `[RTS] ${axis}: position zeroed (final SET_HOME) ✅`);
                        setTimeout(() => {
                            this._homingPhase = null;
                            this._onHomingComplete();
                        }, 200);
                    }, 100);
                } else {
                    this.emit('console', `[RTS] ${axis}: switch triggered — next axis...`);
                    this._homingPhase = null;
                    this._onHomingComplete();
                }
            });
        });
    }

    /**
     * Wait for motion to complete on the current homing axis.
     * Detects either 0xA1 response or state transition to Idle.
     * Times out after 15 seconds.
     */
    _awaitMotionComplete(callback) {
        // Three completion signals, whichever fires first wins:
        //   1. 0xa1 'E' (0x45) frame — primary, set via _pendingMotionCallback.
        //   2. State byte transitions out of 0x08 — fallback.
        //   3. Per-phase timeout — last-resort proceed-anyway.
        //
        // Vendor pcap timings:
        //   back-off ≈ 200 ms, slow seek ≈ 1.4 sec.
        // Tawfiq's machine (session 18:36, latest Z attempt):
        //   Z back-off 'E' arrived ~2.7 sec after the command was sent —
        //   13× slower than vendor. Probably motor accel / closed-loop
        //   driver settling on the Z axis specifically. With a flat 2.5 s
        //   phase timeout we miss the back-off 'E' by milliseconds and
        //   mis-attribute it to the next phase (slow_seek), so slow_seek
        //   gets skipped. Solution: give back-off 5 sec and slow_seek 6
        //   sec headroom. Both still fail fast on a genuinely dead axis.
        const PHASE_TIMEOUT_MS =
            this._homingPhase === 'backoff'   ? 3000 :   // Was 12000 — too long. Z back-off 10mm @ feed500 = 1.2s, 3s is safe upper bound.
            this._homingPhase === 'slow_seek' ? 5000 :   // Was 8000 — Z slow 15mm @ feed200 = 4.5s.
            2500;

        // Minimum-time guard for Z ONLY. msg 6770 capture showed the firmware
        // emits a false 0xA1 within 1ms of JOG_ACK only on the Z axis (where
        // the limit switch stays held after fast-seek). X and Y don't show
        // this behavior — applying the guard to them caused X/Y back-off
        // settles to be delayed (msg 6774 regression report).
        // Guard for Z back-off + slow-seek phases only.
        const FALSE_ACK_GUARD_MS = (this._homingAxis === 'Z' &&
            (this._homingPhase === 'backoff' || this._homingPhase === 'slow_seek')) ? 250 : 0;

        let settled = false;
        const startTime = Date.now();
        const settle = (reason) => {
            if (settled) return;
            const elapsed = Date.now() - startTime;
            if (elapsed < FALSE_ACK_GUARD_MS && reason !== 'phase-timeout') {
                logger.debug(`[RTS] motion-complete signal ignored (${reason}, ${elapsed}ms < ${FALSE_ACK_GUARD_MS}ms guard) phase=${this._homingPhase}`);
                return;
            }
            settled = true;
            this._pendingMotionCallback = null;
            clearInterval(checkInterval);
            logger.info(`[RTS] motion complete (${reason}, ${elapsed}ms) phase=${this._homingPhase}`);
            // Settle delay cut 200ms → 30ms (msg 6786 — visible delay between back-off and slow-seek).
            setTimeout(() => {
                if (this._homing) callback();
            }, 30);
        };
        this._pendingMotionCallback = () => settle('0xa1 E');

        const checkInterval = setInterval(() => {
            if (settled) return;
            if (!this._homing) {
                settled = true;
                this._pendingMotionCallback = null;
                clearInterval(checkInterval);
                return;
            }
            if (Date.now() - startTime > PHASE_TIMEOUT_MS) {
                logger.warn(`[RTS] motion complete TIMEOUT (${PHASE_TIMEOUT_MS} ms) during ${this._homingPhase} — proceeding`);
                settle('phase-timeout');
                return;
            }
            if (this._activeState === 'Idle' || this._activeState === 'Run') {
                settle('state→Idle/Run');
                return;
            }
        }, 100);

        // Track this interval so E-Stop can clear it
        this._homingIntervals = this._homingIntervals || [];
        this._homingIntervals.push(checkInterval);
    }

    /**
     * Called when homing completes (state transitions from Home to Idle).
     * If more axes are queued, starts the next one. Otherwise finishes.
     */
    _onHomingComplete() {
        if (this._homingTimer) {
            clearTimeout(this._homingTimer);
            this._homingTimer = null;
        }

        const axis = this._homingAxis || 'all';
        logger.info(`[RTS] Homing complete for ${axis}`);
        this.emit('console', `[RTS] ${axis} axis homed — position zeroed`);

        // Check if more axes to home
        if (this._homingQueue && this._homingQueue.length > 0) {
            // Short delay before homing next axis (let board settle)
            setTimeout(() => {
                if (this._homing) {
                    this._startNextAxisHome();
                }
            }, 500);
            return;
        }

        // All axes done
        this._homing = false;
        this._homingAxis = null;
        this._homingQueue = [];

        logger.info('[RTS] All homing complete');
        this.emit('homing:location', { location: 'all', status: 'completed' });
        this.emit('console', '[RTS] Homing complete — all axes zeroed');

        // Tell the firmware to exit homing SysMode and return to GENERAL
        // mode. Without this, the firmware stays in homing-axis context
        // (last axis = Y, axisIdx=1). Subsequent jog commands that don't
        // affect Y get partial/incorrect execution — symptom: X and Y
        // jog after homing, Z (and A) don't move at all.
        // Reported by Tawfiq msg 6672 + 6666 after 7cfeb89 landed.
        this._sendSysModeExit();

        // Request fresh status to update position
        this._sendQueryFrame(REG_STATUS);

        // Request work coordinate offsets to sync WCS
        setTimeout(() => {
            if (this.connection) {
                this._sendQueryFrame(REG_CONFIG_TYPE);
            }
        }, 200);
    }

    /**
     * Unlock/clear alarm.
     */
    _unlock() {
        logger.info('[RTS] Sending unlock — binary $X (CMD 0x81)');
        // Start grace period — suppress MotorError/Alarm from B0 polls for 3 seconds
        this._motorResetTime = Date.now();
        // Binary unlock from Wireshark: 01 06 00 81 58 FF
        this._writeFrame(Buffer.from([CMD_QUERY, CMD_UNLOCK, 0x58]));
        this._writeFrame(Buffer.from([CMD_QUERY, CMD_UNLOCK, 0x58]));
        this._writeAscii('$X\n');
        setTimeout(() => {
            if (this._activeState === 'Alarm' || this._activeState === 'MotorError') {
                logger.info('[RTS] Still in alarm after unlock, trying soft reset');
                this._writeAscii('\x18');
            }
        }, 500);
        // Re-push machine config after unlock (helps board re-initialize)
        setTimeout(() => this._pushMachineConfig(), 800);
        // Optimistically update state — will be corrected by next B0 poll
        this._activeState = 'Idle';
        this._updateStateObject();
        this.emit('state', this.getState());
        this.emit('status', this.state.status);
    }

    /**
     * Reset a specific motor's closed-loop error.
     * @param {string} axis - 'X', 'Y', 'Z', or 'A'
     */
    _motorReset(axis) {
        const axisUpper = String(axis).toUpperCase();
        logger.info(`[RTS] Resetting motor: ${axisUpper}`);
        this._motorResetTime = Date.now();

        // CMD 0x07 value = motor index (from live stream analysis)
        // X=0, Y1=1, Y2=2, Z=3
        // For "Y" axis, clear BOTH Y1 and Y2
        if (axisUpper === 'Y') {
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.Y1]));
            setTimeout(() => {
                this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.Y2]));
            }, 600);
            this.emit('console', '🔄 Y1 + Y2 motors reset sent');
        } else {
            const idx = MOTOR_INDEX[axisUpper] !== undefined ? MOTOR_INDEX[axisUpper] : 0;
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, idx]));
            this.emit('console', `🔄 Motor ${axisUpper} (index ${idx}) reset sent`);
        }
        this.emit('motor:status', { axis: axisUpper, status: 'reset' });
    }

    /**
     * Reset all motors' closed-loop errors.
     */
    _motorResetAll() {
        logger.info('[RTS] Resetting all 4 motors (X, Y1, Y2, Z)');
        this._motorResetTime = Date.now();

        // From live stream: clear each motor by index, one at a time
        // X=0, Y1=1, Y2=2, Z=3
        // RTS-X clears them individually, not all at once

        this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.X]));
        this.emit('console', '🔄 Clearing X motor...');

        setTimeout(() => {
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.Y1]));
            this.emit('console', '🔄 Clearing Y1 motor...');
        }, 600);

        setTimeout(() => {
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.Y2]));
            this.emit('console', '🔄 Clearing Y2 motor...');
        }, 600);

        setTimeout(() => {
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.Z]));
            this.emit('console', '🔄 Clearing Z motor...');
        }, 900);

        // Optimistically clear state
        this._activeState = 'Idle';
        this._updateStateObject();
        this.emit('state', this.getState());
        this.emit('console', '[RTS] All motors reset');
        this.emit('motor:status', { axis: 'all', status: 'reset' });
    }

    /**
     * Feed hold (pause motion). Vendor RTS protocol: byte 0x04.
     * Frame: 01 05 00 04 FF
     */
    _feedHold() {
        logger.info('[RTS TX] CMD 0x04 (requestFeedHold)');
        this._writeFrame(Buffer.from([CMD_QUERY, 0x04]));
    }

    /**
     * Resume motion (cycle start). Vendor RTS protocol: byte 0x06.
     * Frame: 01 05 00 06 FF
     */
    _cycleStart() {
        logger.info('[RTS TX] CMD 0x06 (requestCycleStart)');
        this._writeFrame(Buffer.from([CMD_QUERY, 0x06]));
    }

    /**
     * Soft reset / abort. Vendor RTS protocol: byte 0x03 (requestAbort).
     * Frame: 01 05 00 03 FF
     * (NOT ASCII Ctrl-X — that's GRBL syntax which RTS ignores.)
     */
    _softReset() {
        logger.info('[RTS TX] CMD 0x03 (requestAbort)');
        this._writeFrame(Buffer.from([CMD_QUERY, 0x03]));
        this._running = false;
        this._paused = false;
    }

    /**
     * Emergency stop — immediately halt all motion.
     * Uses RTS-1 binary protocol: zero velocity jog + disable jog mode + soft reset.
     * Also cancels any active homing sequence.
     */
    _estop() {
        logger.info('[RTS] *** EMERGENCY STOP ***');

        // 1. CMD 0x21 — zero/stop all axes (most reliable stop from live stream)
        const zeroBuf = Buffer.alloc(18);
        zeroBuf[0] = CMD_QUERY;
        zeroBuf[1] = CMD_ZERO_AXES;
        this._writeFrame(zeroBuf);

        // 2. Zero velocity jog
        this._sendJogFrame(0, 0, 0, 0);

        // 3. Disable jog mode
        this._writeFrame(Buffer.from([CMD_QUERY, CMD_JOG_MODE, 0x00]));

        // 4. Send stop again for reliability
        this._writeFrame(zeroBuf);
        this._sendJogFrame(0, 0, 0, 0);

        // 5. ASCII soft reset as backup
        this._writeAscii('\x18');

        // 5. Cancel any active homing — MUST clear all timers/intervals
        this._homing = false;  // Set FIRST so all callbacks check and exit
        this._homingAxis = null;
        this._homingPhase = null;
        this._homingQueue = [];
        if (this._homingTimer) {
            clearTimeout(this._homingTimer);
            this._homingTimer = null;
        }
        // Clear all motion-wait intervals
        if (this._homingIntervals) {
            for (const interval of this._homingIntervals) {
                clearInterval(interval);
            }
            this._homingIntervals = [];
        }
        this.emit('console', '[RTS] Homing cancelled by E-STOP');

        // 6. Cancel any active jog
        if (this._jogStopTimer) {
            clearTimeout(this._jogStopTimer);
            this._jogStopTimer = null;
        }
        this._jogTarget = null;
        this._jogActive = false;

        // 7. Update state
        this._running = false;
        this._paused = false;
        this._activeState = 'Alarm';
        this._updateStateObject();
        this.emit('state', this.getState());
        this.emit('console', '[RTS] *** EMERGENCY STOP — all motion halted ***');
    }

    /**
     * Clear emergency stop — unlock and resume.
     * Uses both binary unlock (CMD 0x81) and ASCII $X.
     */
    _clearEstop() {
        logger.info('[RTS] Clearing E-STOP / alarm');
        this._motorResetTime = Date.now();
        const zeroBuf = Buffer.alloc(18);
        zeroBuf[0] = CMD_QUERY;
        zeroBuf[1] = CMD_ZERO_AXES;
        this._writeFrame(zeroBuf);
        setTimeout(() => {
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, 0x00]));
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_UNLOCK, 0x58]));
        }, 500);
        this.emit('console', '🔄 E-STOP clear sent...');
    }

    /**
     * Clear limit switch / travel limit error.
     * Stops motion, clears all 4 motors, unlocks, and re-pushes config.
     * This handles the case where an axis hits its mechanical travel limit.
     */
    _clearLimitError() {
        logger.info('[RTS] Clearing limit switch / travel error');
        this._motorResetTime = Date.now();

        // Cancel any active homing
        if (this._homing) {
            this._homing = false;
            this._homingAxis = null;
            this._homingPhase = null;
            this._homingQueue = [];
            if (this._homingTimer) {
                clearTimeout(this._homingTimer);
                this._homingTimer = null;
            }
        }

        // Step 1: Stop all motion
        this._sendJogFrame(0, 0, 0, 0);

        // Step 2: Clear each motor individually (X=0, Y1=1, Y2=2, Z=3)
        this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.X]));
        setTimeout(() => this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.Y1])), 200);
        setTimeout(() => this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.Y2])), 400);
        setTimeout(() => this._writeFrame(Buffer.from([CMD_QUERY, CMD_CLEAR_ERROR, MOTOR_INDEX.Z])), 600);

        // Step 3: Unlock
        setTimeout(() => {
            this._writeFrame(Buffer.from([CMD_QUERY, CMD_UNLOCK, 0x58]));
        }, 800);

        // Step 4: Re-push config to re-initialize
        setTimeout(() => {
            this._pushMachineConfig();
            this._activeState = 'Idle';
            this._updateStateObject();
            this.emit('state', this.getState());
            this.emit('status', this.state.status);
            this.emit('console', '✅ Limit error cleared — machine ready');
        }, 1500);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Move API — Abstraction for absolute/relative positioning
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Move to a position using G-code.
     * @param {object} params - {x, y, z, a, feedRate, mode: 'absolute'|'relative'}
     */
    _move(params = {}) {
        const { x, y, z, a, feedRate = 1000, mode = 'relative' } = params;

        const axes = [];
        if (x !== undefined) axes.push(`X${x}`);
        if (y !== undefined) axes.push(`Y${y}`);
        if (z !== undefined) axes.push(`Z${z}`);
        if (a !== undefined) axes.push(`A${a}`);

        if (axes.length === 0) return;

        const distMode = mode === 'absolute' ? 'G90' : 'G91';
        const gcode = `${distMode} G21 G1 ${axes.join(' ')} F${feedRate}`;
        logger.info(`[RTS] Move: ${gcode}`);
        this._sendGcode(gcode);

        // Return to absolute mode if we switched
        if (mode === 'relative') {
            this._sendGcode('G90');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Connection Health Monitoring
    // ═══════════════════════════════════════════════════════════════════════

    _startHealthMonitor() {
        this._stopHealthMonitor();
        this._healthTimer = setInterval(() => {
            const now = Date.now();
            const elapsed = now - this._lastResponseTime;

            if (elapsed > HEALTH_STALE_TIMEOUT) {
                this._missedPolls++;
                if (this._missedPolls === 1) {
                    logger.warn(`[RTS] Connection stale — no response for ${elapsed}ms`);
                    this.emit('health:stale', { elapsed, missedPolls: this._missedPolls });
                }
                if (this._missedPolls >= 10) {
                    logger.error('[RTS] Connection appears dead — 10+ missed polls');
                }
            }
        }, HEALTH_STALE_TIMEOUT);
    }

    _stopHealthMonitor() {
        if (this._healthTimer) {
            clearInterval(this._healthTimer);
            this._healthTimer = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Work Coordinate System
    // ═══════════════════════════════════════════════════════════════════════

    _setWCS(wcs) {
        // wcs is like 'G54', 'G55', etc.
        if (wcs && /^G5[4-9]$/.test(wcs)) {
            this._sendGcode(wcs);
            this.state.parserstate.modal.wcs = wcs;
            this.emit('parserstate', this.state.parserstate);
        }
    }

    _zeroWCS(params = {}) {
        const axes = params?.axes || ['X', 'Y', 'Z'];
        const wcs = params?.wcs || 'G54';
        const wcsNum = parseInt(wcs.replace('G', '')) - 53; // G54=1, G55=2, etc.
        const axisStr = axes.map(a => `${a.toUpperCase()}0`).join(' ');
        this._sendGcode(`G10 L20 P${wcsNum} ${axisStr}`);
        // Update local WCO
        for (const a of axes) {
            const key = a.toLowerCase();
            if (key in this._wco) {
                this._wco[key] = this._mpos[key] || 0;
            }
        }
        this._updateStateObject();
        this.emit('status', this.state.status);
    }

    _zeroAll() {
        this._zeroWCS({ axes: ['X', 'Y', 'Z'] });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Probing
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Z-axis probe using G38.2 command.
     * @param {object} params - {depth, feedRate, retract}
     */
    _probeZ(params = {}) {
        const depth = params?.depth || 30;
        const feedRate = params?.feedRate || 100;
        const retract = params?.retract || 2;

        logger.info(`[RTS] Probe Z: depth=${depth} feedRate=${feedRate} retract=${retract}`);

        const lines = [
            'G21',                          // mm mode
            'G91',                          // relative mode
            `G38.2 Z-${depth} F${feedRate}`, // probe down
            `G0 Z${retract}`,              // retract
        ];
        this._sendGcode(lines.join('\n'));
        // Return to absolute mode
        this._sendGcode('G90');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Info Queries (missing handlers)
    // ═══════════════════════════════════════════════════════════════════════

    _getParserState() {
        // Emit current parser state
        this.emit('parserstate', this.state.parserstate);
    }

    _getWorkCoordinates() {
        // Query register 0x09 to get work coordinate offsets from board
        this._sendQueryFrame(REG_CONFIG_TYPE);
        // Also emit current offsets
        for (let i = 0; i < this._offsets.length; i++) {
            if (this._offsets[i]) {
                this.emit('parameters', {
                    type: `G${54 + i}`,
                    value: this._offsets[i],
                });
            }
        }
    }

    _checkMode() {
        // GRBL check mode ($C) — send as ASCII passthrough
        this._writeAscii('$C\n');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // G-code Sending
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Send a single G-code line or raw command.
     * @param {string} code
     */
    _sendGcode(code) {
        if (!code) return;
        const lines = code.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            // Check if it's a G-code mode command (G54, G21, etc.)
            if (/^G\d+/.test(line) && line.length <= 5) {
                this._sendGcodeMode(line);
            } else {
                // Send as raw ASCII with newline
                this._writeAscii(line + '\n');
            }
        }
    }

    /**
     * Send raw data.
     * @param {string|Buffer} data
     */
    _sendRaw(data) {
        if (Buffer.isBuffer(data)) {
            if (this.connection) this.connection.writeRaw(data);
        } else {
            this._writeAscii(String(data));
        }
    }

    /**
     * Load G-code for streaming.
     * @param {string} name
     * @param {string} gcode
     */
    _loadGcode(name, gcode) {
        this._gcodeLines = gcode.split('\n').map(l => l.trim()).filter(Boolean);
        this._gcodeIndex = 0;
        this._running = false;
        this._paused = false;
        logger.info(`[RTS] Loaded G-code "${name}" — ${this._gcodeLines.length} lines (first: "${this._gcodeLines[0] || ''}")`);
        this.emit('gcode:load', { name, total: this._gcodeLines.length });
    }

    /**
     * Unload G-code.
     */
    _unloadGcode() {
        this._gcodeLines = [];
        this._gcodeIndex = 0;
        this._running = false;
        this._paused = false;
    }

    /**
     * Start streaming loaded G-code.
     * @param {number} [fromLine=0]
     */
    _startJob(fromLine = 0) {
        if (this._gcodeLines.length === 0) {
            logger.warn('[RTS] _startJob called but no G-code loaded — START is a no-op. Did file:load fire?');
            this.emit('console', '⚠️ START pressed but no G-code is loaded on the controller — re-upload the file.');
            return;
        }

        // Match the vendor capture exactly: NO pre-stream abort, NO
        // sysmode-exit, NO Ctrl-X. Tawfiq's 12:52 screenshot showed that
        // our prior abort sequence (0x03 + 400 ms wait) drove the board
        // through Run → Hold → Run → Jog and locked it in Jog state for
        // the entire stream. The factory app's pcap starts AN1 directly
        // with the board already in state=Run — no abort, no mode reset.
        // Just stream.
        this._startJobInternal(fromLine);
    }

    _startJobInternal(fromLine = 0) {
        if (this._activeState === 'Alarm') {
            logger.info('[RTS] _startJobInternal: board in Alarm — sending unlock first');
            this._unlock();
        }
        this._gcodeIndex = fromLine || 0;
        this._running = true;
        this._paused = false;
        this._boardHolding = false;
        this._lastAckedLine = null;
        this._executedCount = 0;
        this._streamPassCount = 0;
        this._jobStartTime = Date.now();
        // ECSS Module 3 — clear runaway state at the start of every job.
        this._zRunawayHistory = [];
        this._zRunawayFired = false;
        logger.info(`[RTS] _startJob: streaming ${this._gcodeLines.length} lines from line ${this._gcodeIndex} (board activeState=${this._activeState})`);
        this.emit('sender:start');
        this.emit('workflow:state', 'running');
        // vendor-pcap-v1 (msg 7084) — VERBATIM replica of vendor RTS-X
        // TWO_SQUARES protocol decoded from Tawfiq's live USBPcap capture.
        //
        // Vendor app behavior (gold standard, observed bytes):
        //   1. Bulk-push all AN lines back-to-back, ~3 ms between each.
        //      NO wait-for-ack per line. Board's input queue holds them.
        //   2. THEN fire requestCycleStart (0x06). NOT a 500 ms timer.
        //   3. Then poll 0xD5 / 0xD6 / 0xD7 triplet every ~100 ms
        //      (buffer + motor + currentLine). Board's responses drive
        //      progress + back-pressure handling.
        //
        // For files larger than the board's planner depth, this becomes
        // throttled by NACK from the board (future Phase 2). For
        // TWO_SQUARES (21 lines), all fit cleanly in 70 ms + cycle_start
        // = motion starts within ~75 ms of pressing Start.
        this._suppressAckAdvance = true;        // bulk-push: ack-driven advance off
        this._bulkPushAllLines();
    }

    /**
     * ACK-driven streaming — mirrors vendor RTS-X timing from chess pcap
     * (Tawfiq msg 7092, 2674-line file, 60522 ack frames).
     *
     * VENDOR PROTOCOL (verified bytes):
     *   TX line N → wait for 0xA1 ack (A or B) → TX line N+1
     *   Both A (accepted into planner) and B (held in stream buffer)
     *   advance the pointer — vendor doesn't distinguish. For the chess
     *   file: 371 A acks (planner room available) + 60,151 B acks (board
     *   retransmit-acks for stream-buffered lines). Every line still
     *   executed because board internally promotes stream→planner as
     *   planner drains.
     *
     *   AFTER all lines pushed → cycle_start (0x06)
     *   THEN poll 0xD5/D6/D7 every 100 ms during execution
     *
     * Previous (vendor-pcap-v1 Phase 1) used a fixed 3 ms setTimeout —
     * worked for tiny files where everything fit in planner, but on
     * larger files like chess_test the host got too far ahead of board
     * acks and lines were dropped. This Phase 2 version sends the NEXT
     * line only when the previous one's ack arrives — matching what
     * the vendor pcap shows (~1 ms send→ack→next).
     */
    _bulkPushAllLines() {
        const fireAtIdx = this._gcodeIndex;
        const total = this._gcodeLines.length;

        this._bulkSendOne = () => {
            if (!this._running || this._paused || this._boardHolding) return;
            // Honor retry flag from B ack: rewind one line so we resend it.
            // Cap retries at MAX_RETRIES per line to avoid infinite loop.
            const MAX_RETRIES_PER_LINE = 500;
            if (this._bulkAckIsRetry && this._gcodeIndex > 0) {
                this._bulkAckIsRetry = false;
                this._bulkRetryCount = (this._bulkRetryCount || 0) + 1;
                if (this._bulkRetryCount > MAX_RETRIES_PER_LINE) {
                    logger.error(`[RTS] bulk-push: ${MAX_RETRIES_PER_LINE} retries on line ${this._gcodeIndex} — giving up, advancing to avoid stall`);
                    this._bulkRetryCount = 0;
                    // fall through to send NEXT line
                } else {
                    // Resend current line (rewind one)
                    this._gcodeIndex -= 1;
                }
            } else {
                this._bulkRetryCount = 0;
            }
            if (this._gcodeIndex >= total) {
                if (this._bulkCycleStartFired) return;
                this._bulkCycleStartFired = true;
                logger.info(`[RTS] ack-driven push done (${total} lines in ${Date.now() - this._jobStartTime} ms) — firing cycle_start`);
                setTimeout(() => {
                    if (this._running && !this._paused) {
                        logger.info('[RTS TX] CMD 0x06 (requestCycleStart) — push complete');
                        this._cycleStart();
                        this._startBufferPolling();
                    }
                }, 3);
                return;
            }
            const line = this._gcodeLines[this._gcodeIndex];
            const lineNum = this._gcodeIndex + 1;
            this._gcodeIndex++;
            this._sendStreamLine(lineNum, line);
            this.emit('sender:status', {
                sent: this._gcodeIndex,
                total,
                received: this._gcodeIndex - 1,
                startedAt: this._jobStartTime,
                elapsedTime: Date.now() - this._jobStartTime,
                remainingTime: 0,
            });
            this._bulkAckTimer = setTimeout(() => {
                if (this._running && !this._paused) {
                    logger.warn(`[RTS] bulk-push ack-timeout on line ${lineNum} after 100ms — advancing`);
                    this._bulkAckIsRetry = false;
                    this._bulkSendOne();
                }
            }, 100);
        };
        // Kick off the first send
        this._bulkCycleStartFired = false;
        this._bulkSendOne();
    }

    /**
     * Start the vendor-style 0xD5/D6/D7 polling loop, fires every 100 ms.
     * 0xD5 requestStreamBuffer — board returns stream-buffer fill level
     * 0xD6 requestMotorBuffer  — board returns motor-planner fill level
     * 0xD7 requestCurrentLine  — board returns currently-executing line#
     * The 0xD7 response is our authoritative progress signal.
     */
    _startBufferPolling() {
        if (this._bufferPollTimer) return;  // already running
        logger.info('[RTS] bulk-push: starting 0xD5/D6/D7 poll loop (100 ms)');
        const poll = () => {
            if (!this._running) {
                this._stopBufferPolling();
                return;
            }
            // Send triplet (the vendor pcap shows ~0.2 ms between each)
            this._writeFrame(Buffer.from([CMD_QUERY, 0xD5]));
            this._writeFrame(Buffer.from([CMD_QUERY, 0xD6]));
            this._writeFrame(Buffer.from([CMD_QUERY, 0xD7]));
        };
        this._bufferPollTimer = setInterval(poll, 100);
        // Fire immediately too
        poll();
    }

    _stopBufferPolling() {
        if (this._bufferPollTimer) {
            clearInterval(this._bufferPollTimer);
            this._bufferPollTimer = null;
            logger.info('[RTS] bulk-push: stopped 0xD5/D6/D7 poll loop');
        }
    }

    /**
     * Pause G-code streaming.
     */
    _pauseJob() {
        this._paused = true;
        logger.info(`[RTS] _pauseJob: index=${this._gcodeIndex}/${this._gcodeLines.length}`);
        this._feedHold();
        this.emit('sender:hold');
        this.emit('workflow:state', 'paused');
    }

    /**
     * Resume G-code streaming.
     */
    _resumeJob() {
        this._paused = false;
        logger.info(`[RTS] _resumeJob: index=${this._gcodeIndex}/${this._gcodeLines.length}`);
        this._cycleStart();
        this.emit('sender:unhold');
        this.emit('workflow:state', 'running');
        this._sendNextGcodeLine();
    }

    /**
     * Stop G-code streaming.
     */
    _stopJob() {
        this._running = false;
        this._paused = false;
        this._boardHolding = false;
        if (this._cycleStartTimer) {
            clearTimeout(this._cycleStartTimer);
            this._cycleStartTimer = null;
        }
        this._stopStreamPump();
        this._stopBufferPolling();           // vendor-pcap-v1
        this._suppressAckAdvance = false;    // restore legacy ack behavior
        if (this._bulkAckTimer) {
            clearTimeout(this._bulkAckTimer);
            this._bulkAckTimer = null;
        }
        this._bulkSendOne = null;
        this._bulkCycleStartFired = false;
        this._jogCancel(); // Stop motion
        this.emit('sender:end');
        this.emit('workflow:state', 'idle');
    }

    /**
     * Send next G-code line.
     * Driven by the status-poll loop (one line per status frame while the
     * board is in Run/Idle), not by ASCII "ok" — the firmware does not emit
     * "ok" for the binary AN-framed stream. Gated by user-pause AND board-Hold.
     */
    _sendNextGcodeLine() {
        if (!this._running || this._paused || this._boardHolding) return;
        if (this._gcodeIndex >= this._gcodeLines.length) {
            this._running = false;
            this.emit('sender:end');
            this.emit('workflow:state', 'idle');
            return;
        }

        const line = this._gcodeLines[this._gcodeIndex];
        const lineNum = this._gcodeIndex + 1; // 1-based per firmware convention
        this._gcodeIndex++;
        this._sendStreamLine(lineNum, line);

        const elapsed = Date.now() - this._jobStartTime;
        const rate = this._gcodeIndex / (elapsed / 1000);
        const remaining = ((this._gcodeLines.length - this._gcodeIndex) / rate) * 1000;

        this.emit('sender:status', {
            sent: this._gcodeIndex,
            total: this._gcodeLines.length,
            received: this._gcodeIndex - 1,
            startedAt: this._jobStartTime,
            elapsedTime: elapsed,
            remainingTime: remaining || 0,
        });
    }

    /**
     * Handle command acknowledgment - send next line.
     *
     * Currently triggered by ASCII "ok" responses from the RTS-2 firmware
     * (see _onTextData). For lines sent as binary G-code-mode frames the
     * firmware may not emit "ok"; in that case the pipeline relies on the
     * idle-transition fallback below. If you find streaming stalls after
     * the first line on hardware, that's the signal — check whether
     * _onTextData is receiving "ok" lines, or extend the fallback.
     */
    _onAck() {
        if (this._running && !this._paused && this._gcodeIndex < this._gcodeLines.length) {
            this._sendNextGcodeLine();
        }
    }

    /**
     * Idle-transition fallback (kept for back-compat — superseded by
     * _onStreamTick which fires every status frame, not just idle).
     */
    _onIdleAckFallback() {
        this._onStreamTick();
    }

    /**
     * Stream pump driver — call on every incoming status/state frame.
     *
     * Two responsibilities:
     *  1. Refresh `_boardHolding` from the board's reported activeState. If
     *     the board enters Hold (feed-hold pressed, soft hold, etc.) we MUST
     *     stop streaming new lines or the firmware buffer overflows; if it
     *     leaves Hold we should immediately resume from where we paused.
     *  2. Pump exactly one line per status frame as long as it's safe
     *     (running, not user-paused, not board-holding, lines remaining).
     *     Status frames arrive at ~9 Hz on this firmware, so a 414-line
     *     job streams in ~46 s — slow enough not to overrun the firmware
     *     input buffer, fast enough for real machining.
     *
     * This replaces the "wait for ASCII ok" model. The 2026-05-13 USBPcap
     * capture proved the firmware does not emit "ok" for the binary
     * AN-framed stream, so the old _onAck path stalled silently.
     */
    _onStreamTick() {
        const wasHolding = this._boardHolding;
        this._boardHolding = (this._activeState === 'Hold');

        // Edge transition: board just left Hold — resume immediately so
        // pause/resume feels instant. The cmd-0xA6 ack stream will take
        // over pacing from there.
        if (wasHolding && !this._boardHolding && this._running && !this._paused) {
            this.emit('console', '▶️ Resuming stream after board exited Hold');
            this._sendNextGcodeLine();
        }

        // No per-tick pump anymore. The 0xA6 / 0xA2 line-ack stream from
        // the board drives _sendNextGcodeLine at the real consumption rate
        // (~1 line/sec on this firmware). Status-driven pumping was
        // overrunning by 11×.
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Info Requests
    // ═══════════════════════════════════════════════════════════════════════

    _requestSettings() {
        this._sendQueryFrame(REG_CONFIG_TYPE);
    }

    _requestBuildInfo() {
        this._writeAscii('$I\n');
        this._sendQueryFrame(REG_FIRMWARE);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Config Write Helpers
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Write a full machine configuration to the board.
     * @param {object} config - Machine configuration object
     */
    writeConfig(config) {
        if (!config) return;

        // Write axis-specific parameters
        const axisParams = [
            { reg: WREG_STEPS_PER_MM, key: 'steps' },
            { reg: WREG_MAX_VELOCITY, key: 'max_v' },
            { reg: WREG_ACCEL, key: 'accel' },
            { reg: WREG_JERK, key: 'jerk' },
            { reg: WREG_HOME_OFFSET, key: 'home_pos' },
            { reg: WREG_MIN_LIMIT, key: 'min_travel' },
            { reg: WREG_INVERTED, key: 'inverted', isFloat: false },
        ];

        for (const { reg, key, isFloat } of axisParams) {
            if (Array.isArray(config[key])) {
                for (let axis = 0; axis < Math.min(4, config[key].length); axis++) {
                    this._sendWriteRegister(reg, axis, config[key][axis], isFloat !== false);
                }
            }
        }

        // Write scalar parameters
        if (config.probe_speed !== undefined) {
            this._sendWriteRegister(WREG_PROBE_SPEED, 0, config.probe_speed);
        }
        if (config.probe && Array.isArray(config.probe)) {
            if (config.probe[0] !== undefined) this._sendWriteRegister(WREG_PROBE_X, 0, config.probe[0]);
            if (config.probe[1] !== undefined) this._sendWriteRegister(WREG_PROBE_Y, 0, config.probe[1]);
            if (config.probe[2] !== undefined) this._sendWriteRegister(WREG_PROBE_Z, 0, config.probe[2]);
        }
        if (config.spindle_mode !== undefined) {
            this._sendWriteRegister(WREG_SPINDLE_MODE, 0, config.spindle_mode, false);
        }
        if (config.spindle_delay !== undefined) {
            this._sendWriteRegister(WREG_SPINDLE_DELAY, 0, config.spindle_delay, false);
        }
        if (config.pwm_freq !== undefined) {
            this._sendWriteRegister(WREG_PWM_FREQ, 0, config.pwm_freq, false);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // State Accessors (CNCEngine-compatible)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Update the state object that CNCEngine reads.
     */
    _updateStateObject() {
        this.state.status = {
            activeState: this._activeState,
            mpos: { ...this._mpos },
            wpos: { ...this._wpos },
            wco: { ...this._wco },
            feedrate: this._feedrate,
            spindle: this._spindleSpeed,
            spindleDirection: this._spindleDir,
            pinState: '',
            buf: { planner: 0, rx: 0 },
            ov: { ...this._overrides },
        };
    }

    getState() {
        this._updateStateObject();
        return this._activeState;
    }

    getMappedState() {
        const map = {
            'Idle': 'idle',
            'Run': 'run',
            'Hold': 'hold',
            'Home': 'home',
            'Alarm': 'alarm',
            'Jog': 'jog',
            'Check': 'check',
        };
        return map[this._activeState] || 'idle';
    }

    getPosition() {
        return { ...this._wpos };
    }

    getMachinePosition() {
        return { ...this._mpos };
    }

    getWorkflowState() {
        if (this._running && this._paused) return 'paused';
        if (this._running) return 'running';
        return 'idle';
    }

    getSenderStatus() {
        return {
            sent: this._gcodeIndex,
            total: this._gcodeLines.length,
            received: Math.max(0, this._gcodeIndex - 1),
            startedAt: this._jobStartTime,
            elapsedTime: this._running ? Date.now() - this._jobStartTime : 0,
            remainingTime: 0,
            name: '',
            size: 0,
            lines: this._gcodeLines.length,
        };
    }

    getFeederStatus() {
        return {
            hold: false,
            holdReason: null,
            queue: 0,
            pending: 0,
        };
    }

    getToolChangerStatus() {
        return {
            active: false,
            toolNumber: 0,
            state: 'idle',
        };
    }

    getOverrides() {
        return { ...this._overrides };
    }

    getHealthMetrics() {
        return {
            connected: !!this.connection,
            lastResponse: this._lastResponseTime,
            timeSinceLastResponse: this._lastResponseTime ? Date.now() - this._lastResponseTime : -1,
            missedPolls: this._missedPolls,
            reconnectAttempts: 0,
            healthy: this._missedPolls < 3,
        };
    }

    getEventTriggers() {
        return {};
    }

    getSettings() {
        return this._settings;
    }

    getParserState() {
        return this.state.parserstate;
    }

    isInitialized() {
        return this._initialized;
    }

    isIdle() {
        return this._activeState === 'Idle';
    }

    /**
     * Write data to connection (CNCEngine compat).
     * @param {string} data
     * @param {object} [context]
     */
    write(data, context) {
        if (typeof data === 'string') {
            this._writeAscii(data);
        } else if (Buffer.isBuffer(data)) {
            this._sendRaw(data);
        }
    }

    /**
     * Write a line to connection (CNCEngine compat).
     * @param {string} data
     * @param {object} [context]
     */
    writeln(data, context) {
        if (typeof data === 'string') {
            this._writeAscii(data.endsWith('\n') ? data : data + '\n');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Round a position value to 3 decimal places.
     * @param {number} val
     * @returns {number}
     */
    _roundPos(val) {
        if (!Number.isFinite(val)) return 0;
        return Math.round(val * 1000) / 1000;
    }

    /**
     * Clamp velocity to valid range.
     * @param {number} v
     * @returns {number}
     */
    _clampVelocity(v) {
        if (!Number.isFinite(v)) return 0;
        return Math.max(-10000, Math.min(10000, v));
    }

    /**
     * Stub for CNCEngine compatibility - debug monitor.
     */
    get debugMonitor() {
        return {
            getEntries: () => [],
            getStatus: () => ({ enabled: false, entries: 0 }),
        };
    }

    /**
     * Stub for CNCEngine compatibility - health monitor.
     */
    get healthMonitor() {
        return {
            recordPong: () => {},
            getMetrics: () => this.getHealthMetrics(),
        };
    }

    /**
     * Stub for CNCEngine compatibility - sender.
     */
    get sender() {
        return {
            total: this._gcodeLines.length,
            getStatus: () => this.getSenderStatus(),
        };
    }
}

module.exports = { RTSController };
