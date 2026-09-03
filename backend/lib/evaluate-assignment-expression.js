/**
 * evaluate-assignment-expression - Handle assignments in macro expressions.
 *
 * Extends evaluate-expression to handle:
 *   - Simple assignments: x = 10
 *   - Compound assignments: x += 5, x -= 1, x *= 2, x /= 3
 *   - Object path assignments: obj.prop = value
 *   - Computed property assignments: obj[key] = value
 *   - Sequence expressions: x = 1, y = 2 (comma-separated)
 *
 * Allows macros to maintain state across multiple lines:
 *   [x=0]
 *   [x=x+1]
 *   G0 X[x]
 *
 * Reference: gSender evaluate-assignment-expression.js (GPLv3, Sienci Labs Inc.)
 */
const evaluateExpression = require('./evaluate-expression');
const logger = require('../logger');

// Assignment operators
const ASSIGNMENT_OPS = ['=', '+=', '-=', '*=', '/=', '%='];

/**
 * Parse and evaluate an assignment expression, modifying the context.
 *
 * @param {string} expr - The expression (may contain assignments)
 * @param {object} context - Mutable variable context
 * @returns {*} The result of the expression
 *
 * @example
 *   const ctx = {};
 *   evaluateAssignment('x = 10', ctx);     // ctx.x === 10
 *   evaluateAssignment('x = x + 5', ctx);  // ctx.x === 15
 *   evaluateAssignment('y = x * 2', ctx);  // ctx.y === 30
 */
function evaluateAssignment(expr, context = {}) {
    try {
        if (!expr || typeof expr !== 'string') return undefined;

        const trimmed = expr.trim();
        if (!trimmed) return undefined;

        // Handle comma-separated sequence expressions
        if (_hasTopLevelComma(trimmed)) {
            const parts = _splitTopLevel(trimmed, ',');
            let result;
            for (const part of parts) {
                result = evaluateAssignment(part.trim(), context);
            }
            return result;
        }

        // Check for assignment operator
        const assignMatch = _matchAssignment(trimmed);
        if (assignMatch) {
            const { path, op, valueExpr } = assignMatch;
            const value = evaluateExpression(valueExpr, context);

            if (op === '=') {
                _setPath(context, path, value);
            } else {
                const current = _getPath(context, path) || 0;
                let newValue;
                switch (op) {
                    case '+=': newValue = current + value; break;
                    case '-=': newValue = current - value; break;
                    case '*=': newValue = current * value; break;
                    case '/=': newValue = value !== 0 ? current / value : 0; break;
                    case '%=': newValue = current % value; break;
                    default: newValue = value;
                }
                _setPath(context, path, newValue);
            }

            return _getPath(context, path);
        }

        // No assignment - just evaluate
        return evaluateExpression(trimmed, context);
    } catch (err) {
        logger.error(`Assignment expression error: "${expr}" - ${err.message}`);
        return undefined;
    }
}

/**
 * Match an assignment expression and extract parts.
 * @param {string} expr
 * @returns {{ path: string, op: string, valueExpr: string }|null}
 */
function _matchAssignment(expr) {
    // Try each assignment operator (longest first to avoid partial matches)
    for (const op of ['+=', '-=', '*=', '/=', '%=', '=']) {
        const idx = _findAssignmentOp(expr, op);
        if (idx >= 0) {
            const path = expr.slice(0, idx).trim();
            const valueExpr = expr.slice(idx + op.length).trim();

            // Validate that the left side looks like a valid assignment target
            if (/^[a-zA-Z_$][\w$.[\]]*$/.test(path) && valueExpr) {
                return { path, op, valueExpr };
            }
        }
    }
    return null;
}

/**
 * Find an assignment operator, avoiding == and != comparisons.
 * @param {string} expr
 * @param {string} op
 * @returns {number} Index or -1
 */
function _findAssignmentOp(expr, op) {
    let depth = 0;
    for (let i = 0; i < expr.length - op.length + 1; i++) {
        const ch = expr[i];
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (depth === 0 && expr.slice(i, i + op.length) === op) {
            // For '=', make sure it's not ==, ===, !=, !==, <=, >=
            if (op === '=') {
                const before = i > 0 ? expr[i - 1] : '';
                const after = i + 1 < expr.length ? expr[i + 1] : '';
                if (before === '=' || before === '!' || before === '<' || before === '>') continue;
                if (after === '=') continue;
            }
            return i;
        }
    }
    return -1;
}

/**
 * Check if expression has a top-level comma (not inside parens/brackets).
 */
function _hasTopLevelComma(expr) {
    let depth = 0;
    for (const ch of expr) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) return true;
    }
    return false;
}

/**
 * Split expression at top-level occurrences of a delimiter.
 */
function _splitTopLevel(expr, delimiter) {
    const parts = [];
    let depth = 0;
    let current = '';

    for (const ch of expr) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;

        if (ch === delimiter && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current) parts.push(current);
    return parts;
}

/**
 * Get a value from an object by dot-separated path.
 */
function _getPath(obj, path) {
    const parts = path.replace(/\[(\w+)\]/g, '.$1').split('.');
    let current = obj;
    for (const part of parts) {
        if (current == null) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Set a value on an object by dot-separated path.
 */
function _setPath(obj, path, value) {
    const parts = path.replace(/\[(\w+)\]/g, '.$1').split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

module.exports = evaluateAssignment;
