/**
 * ensure-type - Safe type coercion utilities.
 *
 * Exports three functions for safe type conversion with defaults:
 *   - ensureBoolean(value, defaultValue)
 *   - ensureString(value, defaultValue)
 *   - ensureNumber(value, defaultValue)
 *
 * Handles undefined and null by returning default values, preventing
 * runtime errors from missing configuration values.
 *
 * Used when reading configuration files to ensure values are correct
 * types even if JSON parsing returns unexpected types.
 *
 * Reference: gSender ensure-type.js (GPLv3, Sienci Labs Inc.)
 */

/**
 * Ensure a value is a boolean.
 * @param {*} value
 * @param {boolean} [defaultValue=false]
 * @returns {boolean}
 */
function ensureBoolean(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const lower = value.toLowerCase().trim();
        if (lower === 'true' || lower === '1' || lower === 'yes') return true;
        if (lower === 'false' || lower === '0' || lower === 'no') return false;
    }
    if (typeof value === 'number') return value !== 0;
    return defaultValue;
}

/**
 * Ensure a value is a string.
 * @param {*} value
 * @param {string} [defaultValue='']
 * @returns {string}
 */
function ensureString(value, defaultValue = '') {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'string') return value;
    return String(value);
}

/**
 * Ensure a value is a number.
 * @param {*} value
 * @param {number} [defaultValue=0]
 * @returns {number}
 */
function ensureNumber(value, defaultValue = 0) {
    if (value === undefined || value === null) return defaultValue;
    const num = Number(value);
    if (!Number.isFinite(num)) return defaultValue;
    return num;
}

module.exports = {
    ensureBoolean,
    ensureString,
    ensureNumber,
};
