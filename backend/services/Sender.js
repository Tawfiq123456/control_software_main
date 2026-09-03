/**
 * Sender - G-code streaming with flow control.
 *
 * Supports two streaming protocols:
 *   A. Character-Counting (Grbl): Tracks RX buffer size, sends lines only
 *      when buffer has space. Queues line lengths for acknowledgment.
 *   B. Send-Response (GrblHAL): Waits for 'ok' before sending next line.
 *      Simpler but slower.
 *
 * Reference: gSender Sender.js (GPLv3, Sienci Labs Inc.)
 * @see https://github.com/Sienci-Labs/gsender/blob/master/src/server/lib/Sender.js
 */
const { EventEmitter } = require('events');
const {
    SP_TYPE_SEND_RESPONSE,
    SP_TYPE_CHAR_COUNTING,
} = require('./controllers/constants');

const DEFAULT_BUFFER_SIZE = 128;

class Sender extends EventEmitter {
    /**
     * @param {number} [sp=SP_TYPE_CHAR_COUNTING] - Streaming protocol type
     * @param {object} [opts]
     * @param {number} [opts.bufferSize=128] - RX buffer size for character-counting mode
     */
    constructor(sp = SP_TYPE_CHAR_COUNTING, opts = {}) {
        super();

        this.sp = sp;
        this.bufferSize = opts.bufferSize || DEFAULT_BUFFER_SIZE;

        // G-code data
        this.name = '';
        this.gcode = '';
        this.lines = [];
        this.total = 0;

        // Streaming state
        this.sent = 0;
        this.received = 0;
        this.hold = false;
        this.holdReason = null;

        // Character-counting queue: tracks byte lengths of sent lines
        this._countdownQueue = [];
        this._bufferUsed = 0;

        // Timing
        this.startTime = 0;
        this.finishTime = 0;
        this.elapsedTime = 0;
        this.remainingTime = 0;

        // Feed override factor (1.0 = 100%)
        this.ovF = 1.0;

        // State
        this._started = false;
        this._finished = false;

        // Data filter (optional transform before sending)
        this.dataFilter = null;
    }

    /**
     * Load G-code for streaming.
     * @param {string} name - File name or identifier
     * @param {string} gcode - Raw G-code content
     * @param {object} [context] - Optional metadata
     */
    load(name, gcode, context) {
        this.name = name || '';
        this.gcode = gcode || '';
        this.lines = this.gcode
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        this.total = this.lines.length;

        this.rewind();

        this.emit('load', {
            name: this.name,
            total: this.total,
            context,
        });
        this.emit('change');
    }

    /**
     * Unload the current G-code.
     */
    unload() {
        this.name = '';
        this.gcode = '';
        this.lines = [];
        this.total = 0;
        this.rewind();
        this.emit('unload');
        this.emit('change');
    }

    /**
     * Reset streaming counters to the beginning.
     */
    rewind() {
        this.sent = 0;
        this.received = 0;
        this.hold = false;
        this.holdReason = null;
        this._countdownQueue = [];
        this._bufferUsed = 0;
        this._started = false;
        this._finished = false;
        this.startTime = 0;
        this.finishTime = 0;
        this.elapsedTime = 0;
        this.remainingTime = 0;
    }

    /**
     * Get the next line(s) to send.
     * For character-counting: may return multiple lines if buffer has space.
     * For send-response: returns one line at a time.
     *
     * Emits 'data' for each line to send.
     * Emits 'start' on first call, 'end' when all lines acknowledged.
     *
     * @param {object} [options]
     * @param {boolean} [options.isOk=false] - Whether this call is triggered by an 'ok' response
     * @returns {boolean} Whether any data was sent
     */
    next(options = {}) {
        if (this.hold) return false;
        if (this.total === 0) return false;

        // Detect start
        if (!this._started) {
            this._started = true;
            this.startTime = Date.now();
            this.emit('start', { total: this.total });
        }

        // Check if we've finished receiving all acks
        if (this.received >= this.total) {
            if (!this._finished) {
                this._finished = true;
                this.finishTime = Date.now();
                this.elapsedTime = this.finishTime - this.startTime;
                this.emit('end', {
                    total: this.total,
                    sent: this.sent,
                    received: this.received,
                    elapsedTime: this.elapsedTime,
                });
                this.emit('change');
            }
            return false;
        }

        // Nothing more to send (but still waiting for acks)
        if (this.sent >= this.total) {
            return false;
        }

        let didSend = false;

        if (this.sp === SP_TYPE_CHAR_COUNTING) {
            didSend = this._nextCharCounting();
        } else {
            didSend = this._nextSendResponse();
        }

        if (didSend) {
            this._updateTiming();
            this.emit('change');
        }

        return didSend;
    }

    /**
     * Character-counting protocol: send as many lines as fit in the buffer.
     * @private
     */
    _nextCharCounting() {
        let didSend = false;

        while (this.sent < this.total) {
            const line = this._getLine(this.sent);
            const lineLen = line.length + 1; // +1 for newline

            if (this._bufferUsed + lineLen > this.bufferSize) {
                break; // Buffer full
            }

            this._bufferUsed += lineLen;
            this._countdownQueue.push(lineLen);
            this.sent++;
            didSend = true;

            this.emit('data', line, { index: this.sent - 1 });
        }

        return didSend;
    }

    /**
     * Send-response protocol: send one line, wait for ok.
     * @private
     */
    _nextSendResponse() {
        if (this.sent > this.received) {
            return false; // Still waiting for ok
        }

        if (this.sent >= this.total) {
            return false;
        }

        const line = this._getLine(this.sent);
        this.sent++;

        this.emit('data', line, { index: this.sent - 1 });
        return true;
    }

    /**
     * Acknowledge a received 'ok' or 'error' response.
     * For character-counting: frees buffer space.
     * For send-response: allows next line to be sent.
     */
    ack() {
        this.received++;

        if (this.sp === SP_TYPE_CHAR_COUNTING && this._countdownQueue.length > 0) {
            const len = this._countdownQueue.shift();
            this._bufferUsed -= len;
            if (this._bufferUsed < 0) this._bufferUsed = 0;
        }

        this.emit('change');
    }

    /**
     * Pause streaming.
     * @param {string} [reason] - Optional reason for the hold
     */
    holdStreaming(reason) {
        this.hold = true;
        this.holdReason = reason || 'hold';
        this.emit('hold', { reason: this.holdReason });
        this.emit('change');
    }

    /**
     * Resume streaming.
     */
    unhold() {
        this.hold = false;
        this.holdReason = null;
        this.emit('unhold');
        this.emit('change');
    }

    /**
     * Set the feed override factor (for time estimation).
     * @param {number} factor - Override percentage / 100 (e.g., 1.5 for 150%)
     */
    setFeedOverride(factor) {
        this.ovF = factor || 1.0;
    }

    /**
     * Set an optional data filter function.
     * Called before emitting each line: filter(line, index) => line | null
     * Return null to skip the line.
     * @param {Function|null} filter
     */
    setDataFilter(filter) {
        this.dataFilter = typeof filter === 'function' ? filter : null;
    }

    /**
     * Get a line by index, applying the data filter if set.
     * @private
     */
    _getLine(index) {
        let line = this.lines[index] || '';
        if (this.dataFilter) {
            const filtered = this.dataFilter(line, index);
            if (filtered === null || filtered === undefined) {
                return ''; // Skip
            }
            line = filtered;
        }
        return line;
    }

    /**
     * Update timing estimates.
     * @private
     */
    _updateTiming() {
        if (!this.startTime) return;

        const now = Date.now();
        this.elapsedTime = now - this.startTime;

        if (this.received > 0 && this.total > 0) {
            const avgTimePerLine = this.elapsedTime / this.received;
            const remaining = this.total - this.received;
            this.remainingTime = Math.round(avgTimePerLine * remaining / this.ovF);
        }
    }

    // ─── State Accessors ─────────────────────────────────────────────

    /**
     * Get current streaming state.
     */
    getState() {
        return this._started ? (this._finished ? 'idle' : 'running') : 'idle';
    }

    /**
     * Get progress as a percentage (0-100).
     */
    getProgress() {
        if (this.total === 0) return 0;
        return Math.min(100, (this.received / this.total) * 100);
    }

    /**
     * Get full status snapshot.
     */
    getStatus() {
        return {
            name: this.name,
            total: this.total,
            sent: this.sent,
            received: this.received,
            hold: this.hold,
            holdReason: this.holdReason,
            progress: this.getProgress(),
            elapsedTime: this.elapsedTime,
            remainingTime: this.remainingTime,
            startTime: this.startTime,
            finishTime: this.finishTime,
            state: this.getState(),
            sp: this.sp,
        };
    }

    /**
     * Whether streaming is active (started and not finished).
     */
    get isActive() {
        return this._started && !this._finished;
    }

    /**
     * Whether all lines have been sent (but may not all be acknowledged).
     */
    get isComplete() {
        return this._finished;
    }
}

module.exports = {
    Sender,
    SP_TYPE_SEND_RESPONSE,
    SP_TYPE_CHAR_COUNTING,
    DEFAULT_BUFFER_SIZE,
};
