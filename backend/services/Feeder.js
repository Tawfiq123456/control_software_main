/**
 * Feeder - Command queue for manual/interactive commands.
 *
 * Unlike Sender (which streams G-code files with flow control), Feeder
 * manages a FIFO queue of individual commands: jog, probe, settings,
 * macros, etc.  It sends one command at a time and waits for 'ok'
 * before sending the next.
 *
 * Features:
 *   - Queue management: feed(), next(), clear()
 *   - Flow control: hold(), unhold()
 *   - Outstanding tracking: ack() to mark response received
 *   - Context metadata per command (source, button, etc.)
 *
 * Reference: gSender Feeder.js (GPLv3, Sienci Labs Inc.)
 */
const { EventEmitter } = require('events');

class Feeder extends EventEmitter {
    constructor() {
        super();

        /** @type {Array<{data: string, context: object}>} Pending commands */
        this.queue = [];

        /** @type {boolean} Whether we're waiting for an ack */
        this.pending = false;

        /** @type {boolean} Whether the feeder is held (paused) */
        this.hold = false;

        /** @type {string|null} Reason for hold */
        this.holdReason = null;

        /** @type {{data: string, context: object}|null} Currently outstanding command */
        this.current = null;

        /** @type {number} Total commands fed since last clear */
        this.totalFed = 0;

        /** @type {number} Total commands acknowledged */
        this.totalAcked = 0;
    }

    /**
     * Add one or more commands to the queue.
     * @param {string|string[]} data - Command(s) to queue
     * @param {object} [context={}] - Metadata (source, button name, etc.)
     */
    feed(data, context = {}) {
        if (Array.isArray(data)) {
            for (const line of data) {
                this._enqueue(line, context);
            }
        } else if (typeof data === 'string') {
            const lines = data.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    this._enqueue(trimmed, context);
                }
            }
        }
        this.emit('change');
    }

    /** @private */
    _enqueue(line, context) {
        this.queue.push({ data: line, context: { ...context } });
        this.totalFed++;
    }

    /**
     * Send the next queued command.
     * Returns false if nothing to send or still waiting for ack.
     * Emits 'data' with the command line and context.
     * @returns {boolean}
     */
    next() {
        if (this.hold) return false;
        if (this.pending) return false;
        if (this.queue.length === 0) return false;

        this.current = this.queue.shift();
        this.pending = true;

        this.emit('data', this.current.data, this.current.context);
        this.emit('change');
        return true;
    }

    /**
     * Acknowledge that the controller responded to the outstanding command.
     * Allows the next command to be sent.
     */
    ack() {
        if (!this.pending) return;
        this.pending = false;
        this.totalAcked++;
        this.current = null;
        this.emit('change');
    }

    /**
     * Pause the feeder. Queued commands remain but won't be sent.
     * @param {string} [reason='hold']
     */
    holdFeeding(reason) {
        this.hold = true;
        this.holdReason = reason || 'hold';
        this.emit('hold', { reason: this.holdReason });
        this.emit('change');
    }

    /**
     * Resume the feeder.
     */
    unhold() {
        this.hold = false;
        this.holdReason = null;
        this.emit('unhold');
        this.emit('change');
    }

    /**
     * Clear all queued commands and reset state.
     */
    clear() {
        this.queue = [];
        this.pending = false;
        this.current = null;
        this.hold = false;
        this.holdReason = null;
        this.emit('change');
    }

    /**
     * Reset counters.
     */
    reset() {
        this.clear();
        this.totalFed = 0;
        this.totalAcked = 0;
    }

    // ─── State Accessors ─────────────────────────────────────────

    /** Whether there are pending commands in the queue. */
    isPending() {
        return this.queue.length > 0;
    }

    /** Whether we're waiting for an acknowledgment. */
    hasOutstanding() {
        return this.pending;
    }

    /** Number of commands waiting in the queue. */
    size() {
        return this.queue.length;
    }

    /** Get feeder status snapshot. */
    getStatus() {
        return {
            size: this.queue.length,
            pending: this.pending,
            hold: this.hold,
            holdReason: this.holdReason,
            totalFed: this.totalFed,
            totalAcked: this.totalAcked,
        };
    }
}

module.exports = { Feeder };
