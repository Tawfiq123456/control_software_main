/**
 * Serial service: list ports, open/close, read lines, write.
 *
 * Now uses SerialConnection as the underlying transport layer,
 * supporting both Serial (USB) and Network (Telnet/TCP) connections.
 * Auto-detects connection type based on the path provided.
 *
 * Emits:
 *   "line"  - for each newline-delimited message from the controller
 *   "open"  - when connection is established
 *   "close" - when connection is closed
 *   "error" - on connection errors
 */
const EventEmitter = require('events');
const { SerialConnection } = require('./SerialConnection');

const DEFAULT_BAUD = 115200;

class SerialService extends EventEmitter {
    constructor() {
        super();
        /** @type {SerialConnection|null} */
        this.connection = null;
        /** @type {string|null} Current connection path (COM port or IP) */
        this.currentPath = null;
        /** @type {'serial'|'network'|null} Current connection type */
        this.connectionType = null;
    }

    /**
     * List available serial ports.
     * @returns {Promise<Array<{path: string, manufacturer?: string, serialNumber?: string, vendorId?: string, productId?: string}>>}
     */
    async listPorts() {
        return SerialConnection.listPorts();
    }

    /**
     * Open a serial or network connection.
     * Automatically detects whether the path is an IP address (network/Telnet)
     * or a serial port path (COM3, /dev/ttyUSB0, etc.).
     *
     * @param {string} path - e.g. 'COM3', '/dev/ttyUSB0', or '192.168.1.100'
     * @param {object} [options]
     * @param {number} [options.baudRate=115200] - Baud rate for serial connections
     * @param {boolean} [options.network=false] - Force network mode
     * @param {Function} [options.writeFilter] - Optional write filter function
     */
    async open(path, options = {}) {
        // Close any existing connection first
        if (this.connection && this.connection.isOpen) {
            await this.close();
        }

        const baudRate = options.baudRate || DEFAULT_BAUD;

        this.connection = new SerialConnection({
            path,
            baudRate,
            network: options.network || false,
            writeFilter: options.writeFilter,
        });

        this.currentPath = path;
        this.connectionType = this.connection.type;

        // Forward events from SerialConnection
        this.connection.on('data', (line) => {
            const trimmed = typeof line === 'string' ? line.trim() : String(line).trim();
            if (trimmed) {
                this.emit('line', trimmed);
            }
        });

        this.connection.on('open', () => {
            this.connectionType = this.connection.type;
            this.emit('open');
        });

        this.connection.on('close', (err) => {
            this.currentPath = null;
            this.connectionType = null;
            this.emit('close', err);
        });

        this.connection.on('error', (err) => {
            this.emit('error', err);
        });

        // Open the connection (returns via callback-based API)
        return new Promise((resolve, reject) => {
            this.connection.open((err) => {
                if (err) {
                    this.connection = null;
                    this.currentPath = null;
                    this.connectionType = null;
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Close the current connection.
     */
    async close() {
        if (!this.connection) return;
        return new Promise((resolve) => {
            this.connection.close((err) => {
                this.connection = null;
                this.currentPath = null;
                this.connectionType = null;
                resolve(err);
            });
        });
    }

    /**
     * Write data through the writeFilter (adds newline if not present).
     * @param {string} data - Command to send
     * @param {object} [context] - Optional context for the writeFilter
     */
    write(data, context) {
        if (!this.connection || !this.connection.isOpen) {
            throw new Error('Connection is not open');
        }
        const out = data.trim().endsWith('\n') ? data : data + '\n';
        this.connection.write(out, context);
    }

    /**
     * Write data immediately, bypassing the writeFilter.
     * Used for GRBL realtime commands (?, !, ~, Ctrl-X, jog cancel)
     * that must be sent without modification or delay.
     *
     * @param {string|Buffer} data - Raw data to send
     */
    writeImmediate(data) {
        if (!this.connection || !this.connection.isOpen) {
            throw new Error('Connection is not open');
        }
        this.connection.writeImmediate(data);
    }

    /**
     * Check if the connection is open.
     * @returns {boolean}
     */
    isOpen() {
        return this.connection != null && this.connection.isOpen;
    }

    /**
     * Get the current connection type.
     * @returns {'serial'|'network'|null}
     */
    getConnectionType() {
        return this.connectionType;
    }

    /**
     * Get the current connection path.
     * @returns {string|null}
     */
    getPath() {
        return this.currentPath;
    }

    /**
     * Update the write filter on the active connection.
     * @param {Function} writeFilter - (data, context) => transformedData
     */
    setWriteFilter(writeFilter) {
        if (this.connection) {
            this.connection.setWriteFilter(writeFilter);
        }
    }
}

module.exports = { SerialService, DEFAULT_BAUD };
