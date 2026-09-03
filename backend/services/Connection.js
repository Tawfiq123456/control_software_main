/**
 * Connection - Manages connection lifecycle and firmware detection.
 *
 * Wraps SerialConnection to provide:
 *   - Automatic firmware detection (Grbl vs GrblHAL vs FluidNC)
 *   - Socket.io client management (multiple UI clients per connection)
 *   - Connection state tracking
 *   - Debug logging of serial traffic
 *   - Fallback to default firmware after timeout
 *
 * Modeled after gSender's Connection.js (GPLv3, Sienci Labs Inc.)
 * @see https://github.com/Sienci-Labs/gsender/blob/master/src/server/lib/Connection.js
 */
const { EventEmitter } = require('events');
const { SerialConnection } = require('./SerialConnection');
const logger = require('../logger');
const rspFrame = require('./rsp/frame');

const FIRMWARE_GRBL = 'Grbl';
const FIRMWARE_GRBLHAL = 'GrblHAL';
const FIRMWARE_FLUIDNC = 'FluidNC';
const FIRMWARE_RTS = 'RTS';
const FIRMWARE_RSP = 'RSP'; // custom 0x7E-framed CRC32 protocol (fw_m3_control_sw)
const FIRMWARE_GENERIC = 'Generic'; // [GENERIC MODE] Unknown/proprietary firmware

const FIRMWARE_DETECT_INTERVAL = 1500;
const FIRMWARE_DETECT_MAX_ATTEMPTS = 6;

class Connection extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.path - Serial port path or IP address
     * @param {number} [options.baudRate=115200]
     * @param {boolean} [options.network=false]
     * @param {string} [options.defaultFirmware='Grbl'] - Fallback firmware if detection fails
     * @param {Function} [options.writeFilter] - Optional write filter
     */
    constructor(options = {}) {
        super();

        this.path = options.path;
        this.baudRate = options.baudRate || 115200;
        this.network = options.network || false;
        this.rtscts = options.rtscts || false;
        this.rawMode = options.rawMode || false;
        // [GENERIC MODE] Default to Generic instead of Grbl when detection fails
        this.defaultFirmware = options.defaultFirmware || FIRMWARE_GENERIC;

        /** @type {Object.<string, object>} Connected Socket.io clients keyed by socket id */
        this.sockets = {};

        /** @type {object|null} Active controller instance (GrblController or GrblHalController) */
        this.controller = null;

        /** @type {string|null} Detected controller type */
        this.controllerType = null;

        /** @type {SerialConnection|null} */
        this.connection = null;

        /** @type {boolean} Whether the connection is currently open */
        this.isOpen = false;

        /** @type {boolean} Whether firmware has been detected */
        this.firmwareDetected = false;

        // Firmware detection state
        this._detectTimer = null;
        this._detectAttempts = 0;
        this._dataBuffer = [];

        /** @type {Buffer} Raw binary buffer for firmware detection */
        this._rawBuffer = Buffer.alloc(0);

        // Write filter
        this._writeFilter = options.writeFilter || null;
    }

    /**
     * Open the connection and begin firmware detection.
     * @param {Function} [callback] - Error-first callback
     */
    open(callback) {
        if (this.isOpen) {
            const err = new Error('Connection is already open');
            if (callback) callback(err);
            return;
        }

        try {
            this.connection = new SerialConnection({
                path: this.path,
                baudRate: this.baudRate,
                network: this.network,
                rtscts: this.rtscts,
                rawMode: this.rawMode,
                writeFilter: this._writeFilter,
            });
        } catch (err) {
            if (callback) callback(err);
            return;
        }

        // Wire up serial events
        if (this.rawMode) {
            // Raw mode: receive raw Buffers for binary protocol detection
            this.connection.on('data', (data) => this._onRawData(data));
        } else {
            this.connection.on('data', (data) => this._onData(data));
            // ALSO listen for raw data to detect binary RTS firmware
            // (RTS boards send binary frames with no newlines, ReadlineParser won't emit them)
            this.connection.on('rawData', (data) => this._onRawData(data));
        }
        this.connection.on('open', () => this._onOpen());
        this.connection.on('close', (err) => this._onClose(err));
        this.connection.on('error', (err) => this._onError(err));

        this.connection.open((err) => {
            if (err) {
                this.connection = null;
                if (callback) callback(err);
                return;
            }
            if (callback) callback(null);
        });
    }

    /**
     * Close the connection and clean up.
     * @param {Error} [err] - Optional error that caused the close
     */
    close(err) {
        this._stopFirmwareDetection();

        if (this.connection) {
            try {
                this.connection.close(() => {});
            } catch (_) {
                // Ignore close errors during cleanup
            }
            this.connection = null;
        }

        this.isOpen = false;
        this.firmwareDetected = false;
        this.controllerType = null;
        this._dataBuffer = [];

        this.emit('close', err);
    }

    /**
     * Register a Socket.io client with this connection.
     * @param {object} socket - Socket.io socket instance
     */
    addConnection(socket) {
        if (!socket || !socket.id) return;
        this.sockets[socket.id] = socket;
        logger.info(`Socket ${socket.id} added to connection ${this.path}`);
    }

    /**
     * Remove a Socket.io client from this connection.
     * @param {object} socket - Socket.io socket instance
     */
    removeConnection(socket) {
        if (!socket || !socket.id) return;
        delete this.sockets[socket.id];
        logger.info(`Socket ${socket.id} removed from connection ${this.path}`);
    }

    /**
     * Write data through the connection (with write filter applied).
     * @param {string|Buffer} data - Data to send
     * @param {object} [context] - Optional context for the write filter
     */
    write(data, context) {
        if (!this.connection || !this.connection.isOpen) return;
        this.connection.write(data, context);
        this.emit('write', data, context);
    }

    /**
     * Write a line to the connection (appends newline).
     * Skips newline for realtime commands (single-byte commands like ?, !, ~).
     * @param {string} data - Data to send
     * @param {object} [context] - Optional context for the write filter
     */
    writeln(data, context) {
        if (!this.connection || !this.connection.isOpen) return;

        // Realtime commands are single bytes that should not get a newline
        const isRealtime = data.length === 1 && (
            data === '?' ||
            data === '!' ||
            data === '~' ||
            data.charCodeAt(0) === 0x18 ||
            data.charCodeAt(0) === 0x85
        );

        if (isRealtime) {
            this.connection.writeImmediate(data);
        } else {
            this.connection.write(data + '\n', context);
        }
        this.emit('write', data, context);
    }

    /**
     * Write data immediately, bypassing write filter.
     * Used for realtime GRBL commands.
     * @param {string|Buffer} data
     */
    writeImmediate(data) {
        if (!this.connection || !this.connection.isOpen) return;
        this.connection.writeImmediate(data);
    }

    /**
     * Write raw binary data (Buffer) directly to the port.
     * Used by RTSController for binary protocol frames.
     * @param {Buffer} data - Raw binary data to send
     */
    writeRaw(data) {
        if (!this.connection || !this.connection.isOpen) return;
        this.connection.writeImmediate(data);
        this.emit('write', data);
    }

    /**
     * Broadcast an event to all connected Socket.io clients.
     * @param {string} eventName
     * @param {...*} args
     */
    emitToSockets(eventName, ...args) {
        Object.values(this.sockets).forEach((socket) => {
            try {
                socket.emit(eventName, ...args);
            } catch (_) {
                // Ignore emit errors on stale sockets
            }
        });
    }

    /**
     * Get the number of connected Socket.io clients.
     * @returns {number}
     */
    get socketCount() {
        return Object.keys(this.sockets).length;
    }

    // ─── Internal Event Handlers ─────────────────────────────────────

    _onOpen() {
        this.isOpen = true;
        this.emit('open');
        logger.info(`Connection opened: ${this.path} (${this.network ? 'network' : 'serial'})`);

        // Begin firmware detection
        logger.info(`Connection ready on ${this.path} — baudRate: ${this.baudRate}, rtscts: ${this.rtscts}, network: ${this.network}`);
        this._startFirmwareDetection();
    }

    _onClose(err) {
        this.isOpen = false;
        this._stopFirmwareDetection();
        this.emit('close', err);
        logger.info(`Connection closed: ${this.path}`);
    }

    _onError(err) {
        logger.error(`Connection error on ${this.path}: ${err?.message}`);
        this.emit('error', err);
    }

    _onData(data) {
        const line = typeof data === 'string' ? data.trim() : String(data).trim();
        if (!line) return;

        // [GENERIC MODE] Log ALL raw serial data at connection level
        logger.info(`[SERIAL RX] ${this.path}: ${line}`);

        this.emit('data', line);

        // Feed data to firmware detection if not yet detected
        if (!this.firmwareDetected) {
            this._dataBuffer.push(line);
            this._checkFirmware(line);
        }
    }

    /**
     * Handle raw binary data from serial port (rawMode).
     * Buffers bytes and scans for RTS binary frames or text lines.
     * @param {Buffer} data
     */
    _onRawData(data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

        logger.info(`[SERIAL RX RAW] ${this.path}: ${buf.length} bytes | ${buf.toString('hex')}`);

        // Emit raw data for controllers that want binary access
        this.emit('rawData', buf);

        // Also try to emit text lines for firmware detection compatibility
        this._rawBuffer = Buffer.concat([this._rawBuffer, buf]);

        // Check for binary RTS frames during firmware detection
        if (!this.firmwareDetected) {
            this._checkBinaryFirmware();
        }
    }

    /**
     * Check raw binary buffer for RTS protocol frames.
     * Looks for the idle frame 01 05 C1 00 FF or any valid RTS frame.
     */
    _checkBinaryFirmware() {
        const buf = this._rawBuffer;

        // RSP protocol (fw_m3_control_sw): 0x7E START .. 0x5A END, byte-
        // stuffed body, CRC32-validated. A bare 0x7E/0x5A byte can appear
        // as noise, so only a full CRC-valid parse counts as detection --
        // a fresh parser per check keeps this stateless/cheap during the
        // short detection window.
        let rspFrames = [];
        try {
            rspFrames = new rspFrame.FrameParser().feed(buf);
        } catch (_) {
            rspFrames = [];
        }
        if (rspFrames.length > 0) {
            logger.info(
                `[RSP BINARY] Detected RSP frame on ${this.path}: ` +
                `type=0x${rspFrames[0].frameType.toString(16).padStart(2, '0')}`
            );
            this._stopFirmwareDetection();
            this._setFirmware(FIRMWARE_RSP);
            return;
        }

        for (let i = 0; i < buf.length; i++) {
            if (buf[i] !== 0x01) continue;

            // Need at least 2 bytes for start + length
            if (i + 1 >= buf.length) break;

            const frameLen = buf[i + 1];
            if (frameLen < 3 || frameLen > 250) continue;

            // Check if we have the complete frame
            if (i + frameLen > buf.length) break;

            // Check end byte
            if (buf[i + frameLen - 1] !== 0xFF) continue;

            // Valid frame found - check if it's a known RTS frame
            const cmdByte = buf[i + 2];

            // C1 = machine state (idle message), B0 = status, A0 = JSON, 01 = firmware
            if (cmdByte === 0xC1 || cmdByte === 0xB0 || cmdByte === 0xA0 || cmdByte === 0x01) {
                const frameHex = buf.slice(i, i + frameLen).toString('hex');
                logger.info(`[RTS BINARY] Detected RTS frame on ${this.path}: ${frameHex}`);
                this._stopFirmwareDetection();
                this._setFirmware(FIRMWARE_RTS);
                return;
            }
        }
    }

    // ─── Firmware Detection ──────────────────────────────────────────

    /**
     * Start the firmware detection sequence.
     * Sends $I command and polls for a response.
     * Falls back to defaultFirmware after max attempts.
     */
    _startFirmwareDetection() {
        this._detectAttempts = 0;
        this.firmwareDetected = false;
        this._dataBuffer = [];

        // Send initial probe command
        this._sendFirmwareProbe();

        // Set up retry interval
        this._detectTimer = setInterval(() => {
            this._detectAttempts++;

            if (this._detectAttempts >= FIRMWARE_DETECT_MAX_ATTEMPTS) {
                // [GENERIC MODE] Timeout — no known firmware detected, use raw serial mode
                this._stopFirmwareDetection();
                logger.warn(`GRBL/RTS startup message not detected on ${this.path} — switching to generic serial mode`);
                this._setFirmware(this.defaultFirmware);
                return;
            }

            // Retry with soft reset + probe
            this._sendFirmwareProbe();
        }, FIRMWARE_DETECT_INTERVAL);
    }

    /**
     * Send firmware detection probe commands.
     */
    _sendFirmwareProbe() {
        if (!this.connection || !this.connection.isOpen) return;

        const attempt = this._detectAttempts;

        if (this.rawMode) {
            // In raw mode, try binary RTS protocol probes
            if (attempt === 0) {
                // Wait for board's unsolicited idle message (01 05 C1 00 FF)
                // The board typically sends this on connect within ~500ms
                setTimeout(() => {
                    if (this.connection && this.connection.isOpen && !this.firmwareDetected) {
                        // Send register 0x09 query (machine config)
                        const probe = Buffer.from([0x01, 0x05, 0x00, 0x09, 0xFF]);
                        this.connection.writeImmediate(probe);
                    }
                }, 300);
                setTimeout(() => {
                    if (this.connection && this.connection.isOpen && !this.firmwareDetected) {
                        // Also try GRBL $I (works on RTS boards too)
                        this.connection.writeImmediate(Buffer.from('$I\n'));
                    }
                }, 600);
            } else if (attempt <= 2) {
                // Send firmware version query
                const probe = Buffer.from([0x01, 0x05, 0x00, 0x01, 0xFF]);
                this.connection.writeImmediate(probe);
            } else if (attempt <= 4) {
                // Try text-based probes as fallback
                this.connection.writeImmediate(Buffer.from('$I\n'));
                this.connection.writeImmediate(Buffer.from('\x18')); // soft reset
            } else {
                this.connection.writeImmediate(Buffer.from('\n'));
            }
            return;
        }

        if (attempt === 0) {
            // First attempt: wait for board to boot, then send probes
            // RTS boards send unsolicited idle message (01 05 C1 00 FF) within ~500ms
            // Also send binary RTS register query to trigger a response
            setTimeout(() => {
                if (this.connection && this.connection.isOpen && !this.firmwareDetected) {
                    // Send binary RTS register query (machine config 0x09)
                    this.connection.writeImmediate(Buffer.from([0x01, 0x05, 0x00, 0x09, 0xFF]));
                }
            }, 200);
            setTimeout(() => {
                if (this.connection && this.connection.isOpen && !this.firmwareDetected) {
                    // Send Buildbotics dump command
                    this.connection.write('D\n');
                }
            }, 400);
            setTimeout(() => {
                if (this.connection && this.connection.isOpen && !this.firmwareDetected) {
                    // Then GRBL build info
                    this.connection.write('$I\n');
                }
            }, 600);
        } else if (attempt <= 2) {
            // Attempts 1-2: Try binary RTS + Buildbotics commands
            // Binary RTS firmware version query
            this.connection.writeImmediate(Buffer.from([0x01, 0x05, 0x00, 0x01, 0xFF]));
            this.connection.write('D\n');
            setTimeout(() => {
                if (this.connection && this.connection.isOpen && !this.firmwareDetected) {
                    this.connection.write('r\n'); // Buildbotics report command
                }
            }, 200);
        } else if (attempt <= 4) {
            // Attempts 3-4: Try GRBL approach with soft reset
            this.connection.writeImmediate('\x18');
            setTimeout(() => {
                if (this.connection && this.connection.isOpen && !this.firmwareDetected) {
                    this.connection.write('$I\n');
                    this.connection.write('\n'); // Empty line to trigger any banner
                }
            }, 200);
        } else {
            // Last attempt: send newlines to trigger any welcome message
            this.connection.write('\n');
            this.connection.write('\n');
        }
    }

    /**
     * Check a line of data for firmware identification strings.
     * @param {string} line
     */
    _checkFirmware(line) {
        const lower = line.toLowerCase();

        // Log every line received during detection for debugging
        logger.info(`Firmware probe response on ${this.path}: ${line.substring(0, 200)}`);

        // Check for RTS/Buildbotics JSON protocol
        if (line.startsWith('{') && (lower.includes('"msgtype"') || lower.includes('"firmware"') || lower.includes('"variables"'))) {
            this._stopFirmwareDetection();
            this._setFirmware(FIRMWARE_RTS);
        } else if (line.startsWith('{') && (lower.includes('"parameter"') || lower.includes('"value"') || lower.includes('"state"'))) {
            // Additional Buildbotics JSON patterns
            this._stopFirmwareDetection();
            this._setFirmware(FIRMWARE_RTS);
        } else if (lower.includes('buildbotics') || lower.includes('gsd rts') || lower.includes('rts-1') || lower.includes('rts-2') || lower.includes('realtimecnc')) {
            this._stopFirmwareDetection();
            this._setFirmware(FIRMWARE_RTS);
        } else if (lower.includes('grblhal')) {
            this._stopFirmwareDetection();
            this._setFirmware(FIRMWARE_GRBLHAL);
        } else if (lower.includes('fluidnc')) {
            this._stopFirmwareDetection();
            this._setFirmware(FIRMWARE_FLUIDNC);
        } else if (lower.includes('grbl')) {
            this._stopFirmwareDetection();
            this._setFirmware(FIRMWARE_GRBL);
        }
    }

    /**
     * Set the detected firmware and emit event.
     * @param {string} firmware
     */
    _setFirmware(firmware) {
        this.controllerType = firmware;
        this.firmwareDetected = true;

        logger.info(`Firmware detected on ${this.path}: ${firmware}`);
        this.emit('firmwareDetected', firmware, this._dataBuffer);
    }

    /**
     * Stop firmware detection timer.
     */
    _stopFirmwareDetection() {
        if (this._detectTimer) {
            clearInterval(this._detectTimer);
            this._detectTimer = null;
        }
    }
}

module.exports = {
    Connection,
    FIRMWARE_GRBL,
    FIRMWARE_GRBLHAL,
    FIRMWARE_FLUIDNC,
    FIRMWARE_RTS,
    FIRMWARE_RSP,
    FIRMWARE_GENERIC,
};
