/**
 * translate-expression - Replace [expression] patterns in G-code strings.
 *
 * Finds all [expression] patterns in a string and evaluates them using
 * evaluate-expression, replacing with computed values.
 *
 * Converts macro templates like:
 *   G0 X[posx] Y[posy]  →  G0 X10.500 Y20.300
 *   G1 Z[zSafe] F[feedRate]  →  G1 Z5.000 F1000
 *
 * Supports assignments that modify context:
 *   [counter = counter + 1]  →  (empty string, but counter is updated)
 *
 * Reference: gSender translate-expression.js (GPLv3, Sienci Labs Inc.)
 */
const evaluateExpression = require('./evaluate-expression');
const evaluateAssignment = require('./evaluate-assignment-expression');
const logger = require('../logger');

/**
 * Translate all [expression] patterns in a string.
 *
 * @param {string} text - The string containing [expressions]
 * @param {object} [context={}] - Variables available in expressions
 * @param {object} [options={}]
 * @param {number} [options.precision=3] - Decimal places for number formatting
 * @returns {string} The translated string
 *
 * @example
 *   translateExpression('G0 X[x] Y[y]', { x: 10.5, y: 20.3 })
 *   // → 'G0 X10.500 Y20.300'
 *
 *   translateExpression('[n=n+1]G1 X[n*10]', { n: 0 })
 *   // → 'G1 X10.000' (n is now 1 in context)
 */
function translateExpression(text, context = {}, options = {}) {
    if (!text || typeof text !== 'string') return text || '';

    const precision = options.precision !== undefined ? options.precision : 3;

    // Match [expression] patterns, handling nested brackets
    return text.replace(/\[([^\]]*)\]/g, (match, expr) => {
        try {
            if (!expr.trim()) return '';

            // Check if it's an assignment
            const hasAssignment = /[^=!<>]=[^=]/.test(expr) ||
                                  /[+\-*/%]=/.test(expr);

            let result;
            if (hasAssignment) {
                result = evaluateAssignment(expr, context);
                // Assignments that don't produce a useful value → empty string
                // (the side effect of updating context is what matters)
                if (result === undefined) return '';
            } else {
                result = evaluateExpression(expr, context);
            }

            if (result === undefined || result === null) return '';

            // Format numbers with specified precision
            if (typeof result === 'number') {
                if (Number.isInteger(result) && precision === 0) {
                    return String(result);
                }
                return result.toFixed(precision);
            }

            return String(result);
        } catch (err) {
            logger.error(`Expression translation error: [${expr}] - ${err.message}`);
            return match; // Return original on error
        }
    });
}

module.exports = translateExpression;
