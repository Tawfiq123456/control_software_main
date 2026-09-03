/**
 * ensure-positive-number - Safe conversion to a positive number.
 *
 * Converts any value to a positive number with a configurable minimum.
 * Uses Number.isFinite() (not global isFinite()) for strict validation
 * without type coercion.
 *
 * Commonly used for user inputs like feed rates, spindle speeds, and
 * jog distances to prevent negative or invalid values.
 *
 * Reference: gSender ensure-positive-number.js (GPLv3, Sienci Labs Inc.)
 */

/**
 * Ensure a value is a positive number.
 *
 * @param {*} value - The value to convert
 * @param {number} [min=0] - Minimum allowed value (default: 0)
 * @returns {number} A positive number >= min
 *
 * @example
 *   ensurePositiveNumber(42)        // 42
 *   ensurePositiveNumber(-5)        // 0
 *   ensurePositiveNumber('100')     // 100
 *   ensurePositiveNumber(null)      // 0
 *   ensurePositiveNumber(-5, 1)     // 1
 *   ensurePositiveNumber(NaN)       // 0
 *   ensurePositiveNumber(Infinity)  // 0
 */
function ensurePositiveNumber(value, min = 0) {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.max(min, num);
}

module.exports = ensurePositiveNumber;
