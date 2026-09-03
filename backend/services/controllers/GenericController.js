/**
 * GenericController - Raw serial passthrough with zero protocol assumptions.
 *
 * [GENERIC MODE] This controller is used when firmware detection fails
 * or the connected board runs unknown/proprietary firmware.
 *
 * It does NOT:
 *   - Poll for status (no "?" commands)
 *   - Expect "ok" responses
 *   - Parse any protocol-specific messages
 *   - Block commands based on health state
 *   - Assume GRBL, grblHAL, or any other protocol
 *
 * It DOES:
 *   - Forward all raw serial data to the frontend
 *   - Forward all frontend commands to the serial port
 *   - Log every byte received for protocol reverse-engineering
 *   - Keep the connection alive without health timeouts
 */
const { EventEmitter } = require('events');
const logger = require('../../logger');

class GenericController extends EventEmitter {
    /**
     * @param {string} [type='Generic'] - Controller type identifier
     */
    constructor(type = 'Generic') {
        super();

        this.type = type;

        /** @type {import('../Connection').Connection|null} */
        this.connection = null;

        /** @type {boolean} Whether controller is bound to a connection */
        this.bound = false;

        /** @type {number} Total bytes received */
        this.bytesReceived = 0;

        /** @type {number} Total bytes sent */
        this.bytesSent = 0;

        /** @type {number} Total lines received */
        this.linesReceived = 0;

        /** @type {string} Firmware version (unknown for generic) */
        this.firmwareVersion = '';
    }

    /**
     * Bind this controller to a Connection instance.
     * @param {import('../Connection').Connection} connection
     */
    bind(connection) {
        if (this.bound) {
            logger.warn('[GENERIC MODE] Controller already bound, unbinding first');
            this.unbind();
        }

        this.connection = connection;
        this.bound = true;

        // [GENERIC MODE] Listen to ALL raw data with no parsing
        this._onData = (line) => {
            this.linesReceived++;
            this.bytesReceived += (line?.length ?? 0);

            // Log every line for protocol reverse-engineering
            const hex = Buffer.from(line || '').toString('hex');
            logger.info(`[RAW SERIAL] ${new Date().toISOString()} | ${line?.length ?? 0} bytes | ${line}`);
            logger.info(`[RAW SERIAL HEX] ${hex}`);

            // Forward raw data to all connected frontend sockets
            this.connection.emitToSockets('serialport:read', line);
            this.connection.emitToSockets('serialport:raw_data', {
                timestamp: Date.now(),
                data: line,
                hex: hex,
                byteCount: line?.length ?? 0,
                lineNumber: this.linesReceived,
            });

            // Emit for CNCEngine
            this.emit('data', line);

            // Try to detect if the board sends JSON (Buildbotics/RTS pattern)
            if (line && line.startsWith('{')) {
                try {
                    const json = JSON.parse(line);
                    logger.info(`[RAW SERIAL] JSON detected: ${JSON.stringify(json)}`);
                    this.emit('json', json);
                } catch (_) {
                    // Not valid JSON, that's fine
                }
            }
        };

        this.connection.on('data', this._onData);

        // Emit initialized event
        logger.info(`[GENERIC MODE] Controller initialized — raw serial passthrough active`);
        logger.info(`[GENERIC MODE] Status polling: DISABLED`);
        logger.info(`[GENERIC MODE] Protocol parsing: DISABLED`);
        logger.info(`[GENERIC MODE] All serial data will be logged and forwarded to frontend`);

        this.emit('initialized', {
            firmwareType: this.type,
            firmwareVersion: 'unknown',
        });

        // Notify frontend
        this.connection.emitToSockets('controller:type', this.type);
        this.connection.emitToSockets('controller:initialized', {
            firmwareType: this.type,
            firmwareVersion: 'Raw Serial Mode',
        });
    }

    /**
     * Unbind from the connection.
     */
    unbind() {
        if (this.connection && this._onData) {
            this.connection.removeListener('data', this._onData);
        }
        this.connection = null;
        this.bound = false;
    }

    /**
     * Send a raw command to the serial port.
     * [GENERIC MODE] No parsing, no queuing, no protocol wrapping.
     * @param {string} cmd - Command to send
     */
    sendRawCommand(cmd) {
        if (!this.connection || !this.connection.isOpen) {
            logger.warn('[GENERIC MODE] Cannot send — connection not open');
            return;
        }

        const data = cmd.endsWith('\n') ? cmd : cmd + '\n';
        this.bytesSent += data.length;

        logger.info(`[RAW SERIAL TX] ${data.trim()}`);
        this.connection.write(data);
    }

    // ─── Command Interface (compatible with CNCEngine) ──────────

    /**
     * Handle commands from CNCEngine/Socket.IO.
     * [GENERIC MODE] All commands are sent raw, no protocol wrapping.
     */
    command(cmd, ...args) {
        switch (cmd) {
            case 'gcode':
            case 'gcode:send':
                // Send G-code or any raw command
                if (args[0]) this.sendRawCommand(String(args[0]));
                break;

            case 'raw':
            case 'command:raw':
                // Raw command passthrough
                if (args[0]) this.sendRawCommand(String(args[0]));
                break;

            case 'jog': {
                // [GENERIC MODE] Build a G-code jog command
                const params = args[0] || {};
                const parts = ['$J=G91'];
                if (params.x !== undefined) parts.push(`X${params.x}`);
                if (params.y !== undefined) parts.push(`Y${params.y}`);
                if (params.z !== undefined) parts.push(`Z${params.z}`);
                if (params.feedRate) parts.push(`F${params.feedRate}`);
                this.sendRawCommand(parts.join(' '));
                break;
            }

            case 'homing':
            case 'home':
                this.sendRawCommand('$H');
                break;

            case 'unlock':
                this.sendRawCommand('$X');
                break;

            case 'reset':
                // Send Ctrl-X (soft reset)
                if (this.connection && this.connection.isOpen) {
                    this.connection.writeImmediate('\x18');
                }
                break;

            case 'feedhold':
                if (this.connection && this.connection.isOpen) {
                    this.connection.writeImmediate('!');
                }
                break;

            case 'cyclestart':
                if (this.connection && this.connection.isOpen) {
                    this.connection.writeImmediate('~');
                }
                break;

            case 'statusreport':
                if (this.connection && this.connection.isOpen) {
                    this.connection.writeImmediate('?');
                }
                break;

            default:
                // [GENERIC MODE] Send any unknown command as raw
                logger.info(`[GENERIC MODE] Unknown command "${cmd}", sending raw: ${args[0] || cmd}`);
                this.sendRawCommand(String(args[0] || cmd));
                break;
        }
    }

    /**
     * Get controller state (minimal for generic mode).
     */
    getState() {
        return {
            type: this.type,
            status: {
                activeState: 'Unknown',
            },
            bytesReceived: this.bytesReceived,
            bytesSent: this.bytesSent,
            linesReceived: this.linesReceived,
        };
    }

    /**
     * Destroy the controller.
     */
    destroy() {
        this.unbind();
        this.removeAllListeners();
    }
}

module.exports = { GenericController };
