/**
 * rotary - Rotary file detection utility.
 *
 * Checks if G-code contains 'A' axis commands (after removing comments)
 * to identify rotary machining files. Used to show rotary icon in UI
 * and enable rotary-specific features like axis wrapping visualization.
 *
 * Reference: gSender rotary.js (GPLv3, Sienci Labs Inc.)
 */

/**
 * Check if G-code content contains rotary (A-axis) commands.
 *
 * @param {string} gcode - Raw G-code content
 * @returns {boolean} True if the file contains A-axis movements
 *
 * @example
 *   isRotaryFile('G0 X10 Y20 Z5')        // false
 *   isRotaryFile('G0 X10 A90')            // true
 *   isRotaryFile('G0 X10 ; A-axis note')  // false (in comment)
 */
function isRotaryFile(gcode) {
    if (!gcode || typeof gcode !== 'string') return false;

    const lines = gcode.split('\n');

    for (const line of lines) {
        // Strip comments: semicolon style and parenthesis style
        const stripped = line
            .replace(/;.*$/, '')        // Remove ; comments
            .replace(/\([^)]*\)/g, '')  // Remove (...) comments
            .trim();

        if (!stripped) continue;

        // Check for A axis word: letter A followed by a number
        if (/\bA[+-]?\d/.test(stripped)) {
            return true;
        }
    }

    return false;
}

/**
 * Count the number of A-axis commands in G-code.
 *
 * @param {string} gcode
 * @returns {number}
 */
function countRotaryMoves(gcode) {
    if (!gcode || typeof gcode !== 'string') return 0;

    let count = 0;
    const lines = gcode.split('\n');

    for (const line of lines) {
        const stripped = line
            .replace(/;.*$/, '')
            .replace(/\([^)]*\)/g, '')
            .trim();

        if (stripped && /\bA[+-]?\d/.test(stripped)) {
            count++;
        }
    }

    return count;
}

module.exports = {
    isRotaryFile,
    countRotaryMoves,
};
