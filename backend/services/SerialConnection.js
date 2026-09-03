/**
 * SerialConnection - Low-level hardware communication abstraction
 *
 * Supports both Serial (USB) and Network (Telnet/TCP) connections.
 * Auto-detects connection type based on the path (IP address vs COM port).
 * Uses ReadlineParser for line-based data parsing.
 * Provides writeFilter for command preprocessing and writeImmediate for
 * realtime GRBL commands that bypass filtering.
 *
 * Modeled after gSender's SerialConnection (GPLv3, Sienci Labs Inc.)
 * Adapted for this project's CommonJS architecture.
 *
 * @see https://github.com/Sienci-Labs/gsender/blob/master/src/server/lib/SerialConnection.js
 */
const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const net = require('net');

// Validation constants
const DATABITS = Object.freeze([5, 6, 7, 8]);
const STOPBITS = Object.freeze([1, 2]);
const PARITY = Object.freeze(['none', 'even', 'mark', 'odd', 'space']);
const FLOWCONTROLS = Object.freeze(['rtscts', 'xon', 'xoff', 'xany']);

const DEFAULT_SETTINGS = Object.freeze({
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: false,
    xon: false,
    xoff: false,
    xany: false,
});

const TELNET_PORT = 23;
const NETWORK_TIMEOUT_MS = 4000;

// IPv4 pattern for auto-detecting network connections
const IPV4_REGEX = /^(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;

/**
 * Generate a unique identifier for a connection based on its settings.
 * @param {object} options - Connection options (must include `path`)
 * @returns {string} JSON-encoded identifier
 */
function toIdent(options) {
    const { path } = options || {};
    return JSON.stringify({ type: 'serial', path });
}

/**
 * Determine if a given path looks like an IP address (network connection)
 * rather than a serial port path (e.g. COM3, /dev/ttyUSB0).
 * @param {string} path
 * @returns {boolean}
 */
function isNetworkPath(path) {
    return IPV4_REGEX.test(path);
}

class SerialConnection extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.path - Serial port path (e.g. 'COM3') or IP address (e.g. '192.168.1.100')
     * @param {number} [options.baudRate=115200]
     * @param {number} [options.dataBits=8]
     * @param {number} [options.stopBits=1]
     * @param {string} [options.parity='none']
     * @param {boolean} [options.rtscts=false]
     * @param {boolean} [options.xon=false]
     * @param {boolean} [options.xoff=false]
     * @param {boolean} [options.xany=false]
     * @param {boolean} [options.network=false] - Force network mode even if path doesn't look like an IP
     * @param {Function} [options.writeFilter] - Optional function to preprocess outgoing data: (data, context) => data
     */
    constructor(options = {}) {
        super();

        const { writeFilter, rawMode, ...rest } = options;

        /**
         * @type {boolean} When true, emit raw Buffer data instead of parsed lines
         */
        this.rawMode = rawMode || false;

        // Validate and set write filter
        if (writeFilter) {
            if (typeof writeFilter !== 'function') {
                throw new TypeError(`"writeFilter" must be a function: ${writeFilter}`);
            }
            this.writeFilter = writeFilter;
        } else {
            this.writeFilter = (data) => data;
        }

        // Merge with defaults
        const settings = { ...DEFAULT_SETTINGS, ...rest };

        // Validate options
        if (settings.port) {
            throw new TypeError('"port" is an unknown option, did you mean "path"?');
        }
        if (!settings.path) {
            throw new TypeError(`"path" is not defined: ${settings.path}`);
        }
        if (settings.baudrate) {
            throw new TypeError('"baudrate" is an unknown option, did you mean "baudRate"?');
        }
        if (typeof settings.baudRate !== 'number') {
            throw new TypeError(`"baudRate" must be a number: ${settings.baudRate}`);
        }
        if (!DATABITS.includes(settings.dataBits)) {
            throw new TypeError(`"dataBits" is invalid: ${settings.dataBits}`);
        }
        if (!STOPBITS.includes(settings.stopBits)) {
            throw new TypeError(`"stopBits" is invalid: ${settings.stopBits}`);
        }
        if (!PARITY.includes(settings.parity)) {
            throw new TypeError(`"parity" is invalid: ${settings.parity}`);
        }
        FLOWCONTROLS.forEach((control) => {
            if (typeof settings[control] !== 'boolean') {
                throw new TypeError(`"${control}" must be a boolean: ${settings[control]}`);
            }
        });

        // Auto-detect network mode from path
        if (isNetworkPath(settings.path)) {
            settings.network = true;
        }

        /**
         * @type {string} Connection type identifier
         */
        this.type = settings.network ? 'network' : 'serial';

        /**
         * @type {SerialPort|net.Socket|null} The underlying transport
         */
        this.port = null;

        /**
         * @type {ReadlineParser|null} Line-based parser piped from the port
         */
        this.parser = null;

        /**
         * @type {Function|null} Callback stored for error-first open pattern
         */
        this._openCallback = null;

        // Immutable settings
        Object.defineProperty(this, 'settings', {
            enumerable: true,
            value: Object.freeze(settings),
            writable: false,
        });

        // Bind event listeners so they can be cleanly removed
        this._eventListeners = {
            data: (data) => {
                this.emit('data', data);
            },
            open: () => {
                this.emit('open');
            },
            close: (err) => {
                this.emit('close', err);
            },
            error: (err) => {
                if (err && err.code === 'ECONNRESET') {
                    if (this.port) {
                        this.port.destroy();
                        this.port = null;
                    }
                    if (this._openCallback) {
                        this._openCallback(err);
                    }
                }
                this.emit('error', err);
            },
        };
    }

    /**
     * Unique identifier for this connection (based on path).
     * @type {string}
     */
    get ident() {
        return toIdent(this.settings);
    }

    /**
     * Whether the connection is currently open.
     * @type {boolean}
     */
    get isOpen() {
        if (!this.port) return false;
        if (this.settings.network) {
            return this.port.writable === true;
        }
        return this.port.isOpen === true;
    }

    /**
     * Whether the connection is currently closed.
     * @type {boolean}
     */
    get isClose() {
        return !this.isOpen;
    }

    /**
     * Open the connection (serial or network, auto-detected from path).
     *
     * For serial ports: Opens the SerialPort with configured baud rate and settings.
     * For network: Creates a TCP socket and connects to port 23 (Telnet) at the IP address.
     *
     * @param {Function} [callback] - Error-first callback: callback(err)
     */
    open(callback) {
        this._openCallback = callback || (() => {});
        const { path, baudRate, network, ...rest } = this.settings;

        const looksLikeIP = isNetworkPath(path);

        // Guard: serial port already open
        if (this.port && !looksLikeIP && !network) {
            const err = new Error(`Cannot open serial port "${path}"`);
            this._openCallback(err);
            return;
        }

        // Guard: network socket already open - destroy and reset
        if (this.port && (network || looksLikeIP)) {
            this.port.destroy();
            this.port = null;
            const err = new Error('Serial port connection reset');
            this._openCallback(err);
            return;
        }

        if (network || looksLikeIP) {
            this._openNetwork(path, callback);
        } else {
            this._openSerial(path, baudRate, rest, callback);
        }
    }

    /**
     * Open a TCP/Telnet network connection.
     * @private
     */
    _openNetwork(host, callback) {
        this.type = 'network';
        this.port = new net.Socket();

        // Timeout for initial connection
        this.port.setTimeout(NETWORK_TIMEOUT_MS, () => {
            this.port.destroy();
            if (callback) callback(new Error('Network connection timeout'));
        });

        this.port.once('connect', () => {
            this.port.setTimeout(0);
            if (callback) callback(null);
        });

        this.port.on('error', (err) => {
            this.port.setTimeout(0);
            this.port.destroy();
            if (callback) callback(err);
        });

        this._addPortListeners();
        this.port.connect(TELNET_PORT, host);
    }

    /**
     * Open a USB serial port connection.
     * @private
     */
    _openSerial(path, baudRate, extraSettings, callback) {
        this.type = 'serial';

        // Filter out non-serialport options
        const { network, ...serialOpts } = extraSettings;

        this.port = new SerialPort({
            path,
            baudRate,
            dataBits: serialOpts.dataBits,
            stopBits: serialOpts.stopBits,
            parity: serialOpts.parity,
            rtscts: serialOpts.rtscts,
            xon: serialOpts.xon,
            xoff: serialOpts.xoff,
            xany: serialOpts.xany,
            autoOpen: false,
        });

        this._addPortListeners();
        this.port.open(callback);
    }

    /**
     * Attach event listeners and pipe through ReadlineParser (or raw mode).
     * @private
     */
    _addPortListeners() {
        this.port.on('open', this._eventListeners.open);
        this.port.on('close', this._eventListeners.close);
        this.port.on('error', this._eventListeners.error);

        // ECSS-E: mirror inbound bytes to the remote diag WS (no-op when off).
        const mirror = require('./RemoteDiagMirror');
        const mirrorRx = (buf) => { try { mirror.mirrorRx(buf); } catch (_) {} };

        if (this.rawMode) {
            // Raw mode: emit raw Buffer data directly, no parsing
            this.parser = null;
            this.port.on('data', (buf) => {
                mirrorRx(buf);
                this.emit('rawData', buf);
                this.emit('data', buf);
            });
        } else {
            // Pipe through ReadlineParser for line-based data events
            this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
            this.parser.on('data', this._eventListeners.data);

            // ALSO emit raw data for binary firmware detection (RTS boards send
            // binary frames with no newlines, which ReadlineParser never emits)
            this.port.on('data', (buf) => {
                mirrorRx(buf);
                this.emit('rawData', buf);
            });
        }
    }

    /**
     * Remove all event listeners from port and parser.
     * @private
     */
    _removePortListeners() {
        if (this.port) {
            this.port.removeListener('open', this._eventListeners.open);
            this.port.removeListener('close', this._eventListeners.close);
            this.port.removeListener('error', this._eventListeners.error);
        }
        if (this.parser) {
            this.parser.removeListener('data', this._eventListeners.data);
        }
    }

    /**
     * Close the connection.
     *
     * @param {Function} [callback] - Error-first callback: callback(err)
     */
    close(callback) {
        if (!this.port) {
            const err = new Error(`Cannot close serial port "${this.settings.path}"`);
            if (callback) callback(err);
            return;
        }

        this._removePortListeners();

        if (this.settings.network || this.type === 'network') {
            // Network socket: destroy and fire callback on close
            this.port.once('close', () => {
                if (callback) callback(null);
            });
            this.port.destroy();
        } else {
            // Serial port: use the close method
            this.port.close(callback);
        }

        this.port = null;
        this.parser = null;
    }

    /**
     * Write data to the connection with write filter applied.
     * The writeFilter can transform or inspect outgoing data before it is sent.
     *
     * @param {string|Buffer} data - Data to send
     * @param {object} [context] - Optional context passed to the writeFilter
     */
    write(data, context) {
        if (!this.port || !this.port.isOpen) return;

        const filtered = this.writeFilter(data, context);
        const outBuf = Buffer.from(filtered);
        // ECSS-E: mirror outbound bytes to the remote diag WS.
        try { require('./RemoteDiagMirror').mirrorTx(outBuf); } catch (_) {}
        this.port.write(outBuf, (err) => {
            if (err) {
                console.error('[SerialConnection] Write error:', err.message);
            }
        });
    }

    /**
     * Write data immediately, bypassing the writeFilter.
     * Used for GRBL realtime commands (?, !, ~, 0x18, 0x85, etc.)
     * that must not be altered or delayed.
     *
     * @param {string|Buffer} data - Raw data to send immediately
     */
    writeImmediate(data) {
        if (!this.port || !this.port.isOpen) return;
        // ECSS-E: mirror immediate writes too (E-Stop, abort bytes, etc.)
        try { require('./RemoteDiagMirror').mirrorTx(data); } catch (_) {}
        this.port.write(data, (err) => {
            if (err) {
                // Log but don't throw — prevents unhandled error from killing connection
                console.error('[SerialConnection] Write error:', err.message);
            }
        });
    }

    /**
     * Replace the current writeFilter function.
     *
     * @param {Function} writeFilter - New filter: (data, context) => transformedData
     */
    setWriteFilter(writeFilter) {
        if (typeof writeFilter !== 'function') {
            throw new TypeError(`"writeFilter" must be a function: ${writeFilter}`);
        }
        this.writeFilter = writeFilter;
    }

    // ─── Static Helpers ──────────────────────────────────────────────

    /**
     * List all available serial ports on the system.
     * @returns {Promise<Array<{path: string, manufacturer?: string, serialNumber?: string, vendorId?: string, productId?: string}>>}
     */
    static async listPorts() {
        const ports = await SerialPort.list();
        // Filter out virtual/built-in serial ports — only show real hardware
        const filtered = ports.filter((p) => {
            const path = p.path || '';
            // Blacklist: exclude known virtual/non-hardware ports
            // Built-in virtual serial ports (/dev/ttyS0-ttyS99)
            if (/^\/dev\/ttyS\d+$/.test(path)) return false;
            // Non-hardware system devices
            if (path === '/dev/console' || path === '/dev/tty') return false;
            // Include everything else — real USB devices, network paths, etc.
            return true;
        });
        return filtered.map((p) => ({
            path: p.path,
            manufacturer: p.manufacturer,
            serialNumber: p.serialNumber,
            vendorId: p.vendorId,
            productId: p.productId,
        }));
    }
}

module.exports = { SerialConnection, toIdent, isNetworkPath, DEFAULT_SETTINGS };
