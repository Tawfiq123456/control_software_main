/**
 * gcode-translation - Axis letter replacement and unit conversion.
 *
 * Translates G-code axis letters (e.g., Y→A for rotary) while optionally
 * converting units (metric↔imperial) using 25.4mm/inch conversion.
 *
 * Primary use: converting standard XYZ G-code to rotary axis format
 * for 4-axis machining (wrapping Y-axis around A-axis rotation).
 *
 * Reference: gSender gcode-translation.js (GPLv3, Sienci Labs Inc.)
 */

const MM_PER_INCH = 25.4;

/**
 * Translate axis letters in a G-code line.
 *
 * @param {string} line - G-code line to translate
 * @param {object} [options]
 * @param {string} [options.fromAxis='Y'] - Source axis letter
 * @param {string} [options.toAxis='A'] - Target axis letter
 * @param {string} [options.fromUnits='mm'] - Source units ('mm' or 'in')
 * @param {string} [options.toUnits='mm'] - Target units ('mm' or 'in')
 * @returns {string} Translated G-code line
 *
 * @example
 *   translateAxis('G1 Y10.5 F1000', { fromAxis: 'Y', toAxis: 'A' })
 *   // → 'G1 A10.5 F1000'
 *
 *   translateAxis('G1 X1.0 Y2.0', { fromUnits: 'in', toUnits: 'mm' })
 *   // → 'G1 X25.4 Y50.8'
 */
function translateAxis(line, options = {}) {
    const {
        fromAxis = 'Y',
        toAxis = 'A',
        fromUnits = 'mm',
        toUnits = 'mm',
    } = options;

    if (!line || typeof line !== 'string') return line || '';

    // Skip comments and empty lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('(')) {
        return line;
    }

    const needsConversion = fromUnits !== toUnits;
    const conversionFactor = _getConversionFactor(fromUnits, toUnits);

    // Build regex to match the source axis letter followed by a number
    const axisRegex = new RegExp(
        `(${fromAxis.toUpperCase()})([+-]?\\d*\\.?\\d+)`,
        'gi'
    );

    let result = line.replace(axisRegex, (match, letter, value) => {
        let numValue = parseFloat(value);
        if (needsConversion) {
            numValue *= conversionFactor;
        }
        return `${toAxis.toUpperCase()}${_formatNumber(numValue)}`;
    });

    // If unit conversion is needed, also convert other axis values
    if (needsConversion) {
        const otherAxes = ['X', 'Y', 'Z', 'I', 'J', 'K', 'R', 'F']
            .filter((a) => a !== fromAxis.toUpperCase() && a !== toAxis.toUpperCase());

        for (const axis of otherAxes) {
            const regex = new RegExp(`(${axis})([+-]?\\d*\\.?\\d+)`, 'gi');
            result = result.replace(regex, (match, letter, value) => {
                const numValue = parseFloat(value) * conversionFactor;
                return `${letter.toUpperCase()}${_formatNumber(numValue)}`;
            });
        }
    }

    return result;
}

/**
 * Convert an entire G-code program between units.
 *
 * @param {string} gcode - Full G-code program
 * @param {string} fromUnits - Source units ('mm' or 'in')
 * @param {string} toUnits - Target units ('mm' or 'in')
 * @returns {string} Converted G-code
 */
function convertUnits(gcode, fromUnits, toUnits) {
    if (!gcode || fromUnits === toUnits) return gcode;

    const factor = _getConversionFactor(fromUnits, toUnits);
    const lines = gcode.split('\n');

    return lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('(')) {
            return line;
        }

        // Replace unit mode command
        if (fromUnits === 'mm' && toUnits === 'in') {
            if (trimmed === 'G21') return 'G20';
        } else if (fromUnits === 'in' && toUnits === 'mm') {
            if (trimmed === 'G20') return 'G21';
        }

        // Convert all numeric axis values
        return line.replace(
            /([XYZIJKRF])([+-]?\d*\.?\d+)/gi,
            (match, letter, value) => {
                const numValue = parseFloat(value) * factor;
                return `${letter.toUpperCase()}${_formatNumber(numValue)}`;
            }
        );
    }).join('\n');
}

/**
 * Get conversion factor between unit systems.
 * @private
 */
function _getConversionFactor(from, to) {
    if (from === to) return 1;
    if (from === 'in' && to === 'mm') return MM_PER_INCH;
    if (from === 'mm' && to === 'in') return 1 / MM_PER_INCH;
    return 1;
}

/**
 * Format a number for G-code output.
 * @private
 */
function _formatNumber(num) {
    // Use up to 3 decimal places, trimming trailing zeros
    const fixed = num.toFixed(3);
    return fixed.replace(/\.?0+$/, '') || '0';
}

module.exports = {
    translateAxis,
    convertUnits,
    MM_PER_INCH,
};
