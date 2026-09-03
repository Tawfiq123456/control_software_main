/**
 * EventTrigger - Execute custom G-code at specific program events.
 *
 * Supported events:
 *   onStart      - Before job starts
 *   onStop       - After job completes
 *   onPause      - When job pauses
 *   onResume     - When job resumes
 *   onToolChange - During tool changes
 *
 * Each trigger has:
 *   - enabled: boolean
 *   - event: string (event name)
 *   - trigger: string (human-readable label)
 *   - commands: string (G-code to execute, newline-separated)
 *
 * Reference: gSender EventTrigger.js (GPLv3, Sienci Labs Inc.)
 */
const { EventEmitter } = require('events');

const DEFAULT_EVENTS = {
    onStart: { enabled: false, event: 'onStart', trigger: 'Program Start', commands: '' },
    onStop: { enabled: false, event: 'onStop', trigger: 'Program Stop', commands: '' },
    onPause: { enabled: false, event: 'onPause', trigger: 'Program Pause', commands: '' },
    onResume: { enabled: false, event: 'onResume', trigger: 'Program Resume', commands: '' },
    onToolChange: { enabled: false, event: 'onToolChange', trigger: 'Tool Change', commands: '' },
};

class EventTrigger extends EventEmitter {
    /**
     * @param {Function} [sendCommands] - Function to send G-code commands
     */
    constructor(sendCommands) {
        super();

        /** @type {Object<string, {enabled: boolean, event: string, trigger: string, commands: string}>} */
        this.events = {};

        /** @type {Function|null} */
        this._sendCommands = sendCommands || null;

        // Initialize with defaults
        for (const [key, val] of Object.entries(DEFAULT_EVENTS)) {
            this.events[key] = { ...val };
        }
    }

    /**
     * Set the function used to send G-code commands.
     * @param {Function} fn - (commands: string) => void
     */
    setSendFunction(fn) {
        this._sendCommands = fn;
    }

    /**
     * Configure a trigger event.
     * @param {string} eventName - Event name (onStart, onStop, etc.)
     * @param {object} config
     * @param {boolean} [config.enabled]
     * @param {string} [config.commands]
     */
    set(eventName, config) {
        if (!this.events[eventName]) {
            this.events[eventName] = {
                enabled: false,
                event: eventName,
                trigger: eventName,
                commands: '',
            };
        }

        if (config.enabled !== undefined) this.events[eventName].enabled = config.enabled;
        if (config.commands !== undefined) this.events[eventName].commands = config.commands;
        if (config.trigger !== undefined) this.events[eventName].trigger = config.trigger;

        this.emit('change', this.events);
    }

    /**
     * Load all trigger configurations at once.
     * @param {Object<string, object>} triggers
     */
    loadAll(triggers) {
        for (const [key, val] of Object.entries(triggers)) {
            this.set(key, val);
        }
    }

    /**
     * Fire a trigger event. If the event is enabled and has commands,
     * they will be sent to the controller.
     * @param {string} eventName
     * @returns {boolean} Whether commands were sent
     */
    fire(eventName) {
        const trigger = this.events[eventName];
        if (!trigger || !trigger.enabled || !trigger.commands) {
            return false;
        }

        const commands = trigger.commands.trim();
        if (!commands) return false;

        this.emit('trigger', {
            event: eventName,
            trigger: trigger.trigger,
            commands,
        });

        if (this._sendCommands) {
            this._sendCommands(commands);
        }

        return true;
    }

    /**
     * Get all trigger configurations.
     * @returns {Object<string, object>}
     */
    getAll() {
        const result = {};
        for (const [key, val] of Object.entries(this.events)) {
            result[key] = { ...val };
        }
        return result;
    }
}

module.exports = { EventTrigger, DEFAULT_EVENTS };
