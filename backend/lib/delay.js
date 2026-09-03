/**
 * delay - Promise-based delay utility.
 *
 * Returns a Promise that resolves after the specified milliseconds.
 * Optionally passes a value through as the resolved value.
 *
 * Usage:
 *   await delay(1000);                    // Wait 1 second
 *   const val = await delay(500, 'done'); // Wait 500ms, resolves with 'done'
 *
 * Common use: timing-critical operations like waiting after $DFU command
 * before firmware flashing, or debouncing serial writes.
 *
 * Reference: gSender delay.js (GPLv3, Sienci Labs Inc.)
 */

/**
 * @param {number} ms - Milliseconds to delay
 * @param {*} [value] - Optional value to resolve with
 * @returns {Promise<*>}
 */
function delay(ms, value) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(value), ms);
    });
}

module.exports = delay;
