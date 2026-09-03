/**
 * Workflow - Job execution state machine.
 *
 * States:
 *   IDLE    → No job running
 *   RUNNING → Job in progress
 *   PAUSED  → Job temporarily stopped
 *
 * Coordinates with Sender (G-code streaming) and Feeder (manual commands)
 * to prevent conflicting operations.
 *
 * Reference: gSender Workflow.js (GPLv3, Sienci Labs Inc.)
 */
const { EventEmitter } = require('events');
const {
    WORKFLOW_STATE_IDLE,
    WORKFLOW_STATE_RUNNING,
    WORKFLOW_STATE_PAUSED,
} = require('./controllers/constants');

// Valid transitions: { fromState: [toState, ...] }
const VALID_TRANSITIONS = Object.freeze({
    [WORKFLOW_STATE_IDLE]: [WORKFLOW_STATE_RUNNING],
    [WORKFLOW_STATE_RUNNING]: [WORKFLOW_STATE_PAUSED, WORKFLOW_STATE_IDLE],
    [WORKFLOW_STATE_PAUSED]: [WORKFLOW_STATE_RUNNING, WORKFLOW_STATE_IDLE],
});

class Workflow extends EventEmitter {
    constructor() {
        super();
        this.state = WORKFLOW_STATE_IDLE;
    }

    /**
     * Transition to a new state if the transition is valid.
     * @param {string} newState
     * @returns {boolean} Whether the transition occurred
     */
    _transition(newState) {
        if (this.state === newState) return false;

        const allowed = VALID_TRANSITIONS[this.state];
        if (!allowed || !allowed.includes(newState)) {
            return false;
        }

        const prev = this.state;
        this.state = newState;
        this.emit('state', newState, prev);
        return true;
    }

    /**
     * Start a job. Transitions IDLE → RUNNING.
     * @returns {boolean}
     */
    start() {
        return this._transition(WORKFLOW_STATE_RUNNING);
    }

    /**
     * Pause a running job. Transitions RUNNING → PAUSED.
     * @returns {boolean}
     */
    pause() {
        return this._transition(WORKFLOW_STATE_PAUSED);
    }

    /**
     * Resume a paused job. Transitions PAUSED → RUNNING.
     * @returns {boolean}
     */
    resume() {
        return this._transition(WORKFLOW_STATE_RUNNING);
    }

    /**
     * Stop a job. Transitions RUNNING|PAUSED → IDLE.
     * @returns {boolean}
     */
    stop() {
        return this._transition(WORKFLOW_STATE_IDLE);
    }

    // ─── State Checks ────────────────────────────────────────────

    isIdle() {
        return this.state === WORKFLOW_STATE_IDLE;
    }

    isRunning() {
        return this.state === WORKFLOW_STATE_RUNNING;
    }

    isPaused() {
        return this.state === WORKFLOW_STATE_PAUSED;
    }
}

module.exports = { Workflow };
