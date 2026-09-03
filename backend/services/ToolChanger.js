/**
 * ToolChanger - Manages tool change workflows (M6 commands).
 *
 * When the Sender encounters an M6 (tool change) command:
 *   1. Sender pauses streaming
 *   2. ToolChanger polls for machine idle state
 *   3. Emits 'toolchange:start' for UI notification
 *   4. Waits for user confirmation
 *   5. Emits 'toolchange:complete' and resumes streaming
 *
 * Reference: gSender ToolChanger.js (GPLv3, Sienci Labs Inc.)
 */
const { EventEmitter } = require('events');

const POLL_INTERVAL = 250;
const IDLE_TIMEOUT = 30000;

class ToolChanger extends EventEmitter {
    constructor() {
        super();

        /** @type {boolean} Whether a tool change is in progress */
        this.active = false;

        /** @type {number|null} Current tool number */
        this.currentTool = null;

        /** @type {number|null} Requested tool number */
        this.requestedTool = null;

        /** @type {NodeJS.Timeout|null} Idle polling interval */
        this._pollTimer = null;

        /** @type {NodeJS.Timeout|null} Idle wait timeout */
        this._idleTimeout = null;

        /** @type {Function|null} Status check callback */
        this._getActiveState = null;
    }

    /**
     * Set the function used to query the machine's active state.
     * @param {Function} fn - Returns the active state string (e.g. 'Idle', 'Run')
     */
    setStateProvider(fn) {
        this._getActiveState = fn;
    }

    /**
     * Initiate a tool change request.
     * Called when M6 is detected in the G-code stream.
     * @param {number} toolNumber - The requested tool number
     */
    request(toolNumber) {
        if (this.active) return;

        this.active = true;
        this.requestedTool = toolNumber;

        this.emit('toolchange:request', {
            currentTool: this.currentTool,
            requestedTool: this.requestedTool,
        });

        this._waitForIdle();
    }

    /**
     * Poll until the machine reaches idle state, then emit start event.
     * @private
     */
    _waitForIdle() {
        this._clearTimers();

        this._idleTimeout = setTimeout(() => {
            this._clearTimers();
            this.emit('toolchange:error', {
                message: 'Timeout waiting for machine idle during tool change',
            });
            this.cancel();
        }, IDLE_TIMEOUT);

        this._pollTimer = setInterval(() => {
            if (!this._getActiveState) {
                this._onMachineIdle();
                return;
            }

            const state = this._getActiveState();
            if (state === 'Idle') {
                this._onMachineIdle();
            }
        }, POLL_INTERVAL);
    }

    /**
     * Called when machine reaches idle during a tool change.
     * @private
     */
    _onMachineIdle() {
        this._clearTimers();

        this.emit('toolchange:start', {
            currentTool: this.currentTool,
            requestedTool: this.requestedTool,
        });
    }

    /**
     * Confirm the tool change is complete (called from UI).
     * Updates current tool and signals resume.
     */
    confirm() {
        if (!this.active) return;

        this.currentTool = this.requestedTool;
        this.requestedTool = null;
        this.active = false;

        this._clearTimers();

        this.emit('toolchange:complete', {
            tool: this.currentTool,
        });
    }

    /**
     * Cancel the tool change.
     */
    cancel() {
        this.requestedTool = null;
        this.active = false;
        this._clearTimers();

        this.emit('toolchange:cancel');
    }

    /** @private */
    _clearTimers() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._idleTimeout) {
            clearTimeout(this._idleTimeout);
            this._idleTimeout = null;
        }
    }

    /**
     * Check if a G-code line contains a tool change command.
     * @param {string} line
     * @returns {{ hasTool: boolean, toolNumber: number|null }}
     */
    static parseToolChange(line) {
        const upper = line.toUpperCase().trim();

        // Match M6 (tool change) with optional Tn
        const m6Match = upper.match(/M0*6/);
        if (!m6Match) return { hasTool: false, toolNumber: null };

        // Extract tool number from T word
        const tMatch = upper.match(/T(\d+)/);
        const toolNumber = tMatch ? parseInt(tMatch[1], 10) : null;

        return { hasTool: true, toolNumber };
    }

    /** Get status snapshot. */
    getStatus() {
        return {
            active: this.active,
            currentTool: this.currentTool,
            requestedTool: this.requestedTool,
        };
    }
}

module.exports = { ToolChanger };
