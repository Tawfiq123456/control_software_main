/**
 * decimal-places - Determine the number of decimal places in a number.
 *
 * Handles both standard notation (1.234) and scientific notation (1.23e-4).
 * Used for maintaining appropriate precision when formatting coordinates
 * and feed rates in G-code generation and display.
 *
 * Reference: gSender decimal-places.js (GPLv3, Sienci Labs Inc.)
 */

/**
 * Get the number of decimal places in a number or numeric string.
 *
 * @param {number|string} value - The number to analyze
 * @returns {number} Number of decimal places (0 for integers)
 *
 * @example
 *   decimalPlaces(1.234)    // 3
 *   decimalPlaces('1.23e-4') // 6  (0.000123)
 *   decimalPlaces(42)        // 0
 *   decimalPlaces('1.0')     // 1
 */
function decimalPlaces(value) {
    if (value == null) return 0;

    const str = String(value);

    // Match: optional sign, digits, optional decimal + digits, optional exponent
    const match = str.match(/^[+-]?\d*\.?(\d*)(?:[eE]([+-]?\d+))?$/);
    if (!match) return 0;

    const decimalDigits = match[1] ? match[1].length : 0;
    const exponent = match[2] ? parseInt(match[2], 10) : 0;

    // For scientific notation: actual decimal places = digits - exponent
    // e.g., 1.23e-4 = 0.000123 → 2 digits + 4 = 6 decimal places
    return Math.max(0, decimalDigits - exponent);
}

module.exports = decimalPlaces;
