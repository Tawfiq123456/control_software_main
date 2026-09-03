/**
 * SerialDebugMonitor - Non-invasive logging of all serial communication.
 *
 * Logs:
 *   TX     - Outgoing commands with source tracking
 *   RX     - Incoming responses
 *   UI     - UI button clicks → command mapping
 *   ERROR  - Timeouts, disconnects, invalid responses
 *
 * Features:
 *   - In-memory ring buffer (configurable size)
 *   - Optional file logging with rotation
 *   - Enable/disable at runtime
 *   - Event emission for live UI streaming
 *   - Source tracking (which button/action triggered a command)
 *
 * Reference: gSender SerialDebugMonitor concept
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DEBUG_EVENT_TYPES = Object.freeze({
    TX: 'tx',
    RX: 'rx',
    UI: 'ui',
    ERROR: 'error',
});

const DEFAULT_BUFFER_SIZE = 2000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024; // 5MB

class SerialDebugMonitor extends EventEmitter {
    /**
     * @param {object} [options]
     * @param {boolean} [options.enabled=false]
     * @param {number} [options.bufferSize=2000]
     * @param {string} [options.logDir] - Directory for file logging
     * @param {boolean} [options.fileLogging=false]
     */
    constructor(options = {}) {
        super();

        this.enabled = options.enabled || false;
        this.bufferSize = options.bufferSize || DEFAULT_BUFFER_SIZE;
        this.fileLogging = options.fileLogging || false;
        this.logDir = options.logDir || null;

        /** @type {Array<object>} Ring buffer of log entries */
        this.buffer = [];

        /** @type {fs.WriteStream|null} */
        this._fileStream = null;

        /** @type {number} Current log file size */
        this._fileSize = 0;

        if (this.fileLogging && this.logDir) {
            this._openLogFile();
        }
    }

    /**
     * Enable or disable the monitor.
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        this.enabled = !!enabled;
        this.emit('enabled', this.enabled);
    }

    /**
     * Log an outgoing command (TX).
     * @param {string} data - The command sent
     * @param {object} [meta] - Metadata (source, sourceButton, etc.)
     */
    logTx(data, meta = {}) {
        this._log(DEBUG_EVENT_TYPES.TX, data, meta);
    }

    /**
     * Log an incoming response (RX).
     * @param {string} data - The response received
     * @param {object} [meta]
     */
    logRx(data, meta = {}) {
        this._log(DEBUG_EVENT_TYPES.RX, data, meta);
    }

    /**
     * Log a UI event (button click → command mapping).
     * @param {string} action - The UI action (e.g. "Jog X+")
     * @param {string} [command] - The resulting G-code command
     * @param {object} [meta]
     */
    logUI(action, command, meta = {}) {
        this._log(DEBUG_EVENT_TYPES.UI, `${action}${command ? ' → ' + command : ''}`, {
            ...meta,
            action,
            command,
        });
    }

    /**
     * Log an error event.
     * @param {string} message
     * @param {object} [meta]
     */
    logError(message, meta = {}) {
        this._log(DEBUG_EVENT_TYPES.ERROR, message, meta);
    }

    /**
     * Core logging method.
     * @private
     */
    _log(type, data, meta = {}) {
        if (!this.enabled) return;

        const entry = {
            timestamp: Date.now(),
            type,
            data,
            meta,
        };

        // Ring buffer
        this.buffer.push(entry);
        if (this.buffer.length > this.bufferSize) {
            this.buffer.shift();
        }

        // Emit for live UI streaming
        this.emit('log', entry);

        // File logging
        if (this.fileLogging && this._fileStream) {
            this._writeToFile(entry);
        }
    }

    /**
     * Get recent log entries.
     * @param {number} [count] - Number of entries to return (default: all)
     * @param {string} [type] - Filter by event type
     * @returns {Array<object>}
     */
    getEntries(count, type) {
        let entries = this.buffer;
        if (type) {
            entries = entries.filter((e) => e.type === type);
        }
        if (count && count > 0) {
            entries = entries.slice(-count);
        }
        return entries;
    }

    /**
     * Clear the buffer.
     */
    clear() {
        this.buffer = [];
        this.emit('clear');
    }

    // ─── File Logging ────────────────────────────────────────────

    /** @private */
    _openLogFile() {
        if (!this.logDir) return;

        try {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }

            const filename = `serial-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
            const filepath = path.join(this.logDir, filename);

            this._fileStream = fs.createWriteStream(filepath, { flags: 'a' });
            this._fileSize = 0;
        } catch (err) {
            this._fileStream = null;
        }
    }

    /** @private */
    _writeToFile(entry) {
        if (!this._fileStream) return;

        const line = `${new Date(entry.timestamp).toISOString()} [${entry.type.toUpperCase()}] ${entry.data}\n`;
        const bytes = Buffer.byteLength(line);

        this._fileStream.write(line);
        this._fileSize += bytes;

        // Rotate if file too large
        if (this._fileSize >= MAX_LOG_FILE_SIZE) {
            this._fileStream.end();
            this._openLogFile();
        }
    }

    /**
     * Enable file logging.
     * @param {string} logDir
     */
    enableFileLogging(logDir) {
        this.logDir = logDir;
        this.fileLogging = true;
        this._openLogFile();
    }

    /**
     * Disable file logging.
     */
    disableFileLogging() {
        this.fileLogging = false;
        if (this._fileStream) {
            this._fileStream.end();
            this._fileStream = null;
        }
    }

    /**
     * Close all resources.
     */
    close() {
        if (this._fileStream) {
            this._fileStream.end();
            this._fileStream = null;
        }
    }

    /** Get status snapshot. */
    getStatus() {
        return {
            enabled: this.enabled,
            fileLogging: this.fileLogging,
            bufferSize: this.buffer.length,
            maxBufferSize: this.bufferSize,
        };
    }
}

module.exports = { SerialDebugMonitor, DEBUG_EVENT_TYPES };
