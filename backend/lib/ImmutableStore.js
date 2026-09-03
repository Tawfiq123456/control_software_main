/**
 * ImmutableStore - Immutable state container with change detection.
 *
 * Provides a simple store where state updates produce new objects
 * (shallow copy), enabling efficient change detection and snapshot
 * comparison. Used for controller state that needs to be broadcast
 * only when changed.
 *
 * Reference: gSender ImmutableStore.js (GPLv3, Sienci Labs Inc.)
 */
const { EventEmitter } = require('events');

class ImmutableStore extends EventEmitter {
    /**
     * @param {object} [initialState={}]
     */
    constructor(initialState = {}) {
        super();
        this._state = { ...initialState };
    }

    /**
     * Get the current state (returns a shallow copy).
     * @returns {object}
     */
    get() {
        return { ...this._state };
    }

    /**
     * Get a specific key from the state.
     * @param {string} key
     * @param {*} [defaultValue]
     * @returns {*}
     */
    getKey(key, defaultValue) {
        return this._state[key] !== undefined ? this._state[key] : defaultValue;
    }

    /**
     * Set state (merges with existing state).
     * Only emits 'change' if values actually changed.
     * @param {object} nextState - Partial state to merge
     * @returns {boolean} Whether any values changed
     */
    set(nextState) {
        if (!nextState || typeof nextState !== 'object') return false;

        let changed = false;
        const prevState = this._state;
        const newState = { ...prevState };

        for (const key of Object.keys(nextState)) {
            if (prevState[key] !== nextState[key]) {
                newState[key] = nextState[key];
                changed = true;
            }
        }

        if (changed) {
            this._state = newState;
            this.emit('change', newState, prevState);
        }

        return changed;
    }

    /**
     * Replace the entire state.
     * @param {object} state
     */
    replace(state) {
        const prevState = this._state;
        this._state = { ...state };
        this.emit('change', this._state, prevState);
    }

    /**
     * Clear the state.
     */
    clear() {
        const prevState = this._state;
        this._state = {};
        this.emit('change', this._state, prevState);
    }

    /**
     * Check if a key exists.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return key in this._state;
    }

    /**
     * Delete a key.
     * @param {string} key
     */
    unset(key) {
        if (key in this._state) {
            const prevState = this._state;
            const newState = { ...prevState };
            delete newState[key];
            this._state = newState;
            this.emit('change', this._state, prevState);
        }
    }
}

module.exports = { ImmutableStore };
