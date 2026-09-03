/**
 * evaluate-expression - Safe JavaScript expression evaluator for macros.
 *
 * Parses and evaluates JavaScript expressions using a recursive-descent
 * evaluator (no eval/Function). Supports:
 *   - Arithmetic: +, -, *, /, %, **
 *   - Comparison: ==, !=, <, >, <=, >=, ===, !==
 *   - Logical: &&, ||, !
 *   - Ternary: condition ? a : b
 *   - Unary: -, +, !
 *   - Member access: obj.prop, obj[expr]
 *   - Function calls: Math.sin(x), Math.abs(y)
 *   - Literals: numbers, strings, booleans, null
 *   - Variables from context: x, posx, etc.
 *
 * Powers gSender's macro system allowing users to write dynamic G-code
 * with expressions like G0 X[posx + 10] Y[posy].
 *
 * Reference: gSender evaluate-expression.js (GPLv3, Sienci Labs Inc.)
 */
const logger = require('../logger');

// Safe built-in functions available in expressions
const SAFE_GLOBALS = Object.freeze({
    Math,
    Number,
    parseInt,
    parseFloat,
    isNaN,
    isFinite: Number.isFinite,
    true: true,
    false: false,
    null: null,
    undefined: undefined,
    Infinity,
    NaN,
    PI: Math.PI,
    E: Math.E,
    abs: Math.abs,
    acos: Math.acos,
    asin: Math.asin,
    atan: Math.atan,
    atan2: Math.atan2,
    ceil: Math.ceil,
    cos: Math.cos,
    exp: Math.exp,
    floor: Math.floor,
    log: Math.log,
    max: Math.max,
    min: Math.min,
    pow: Math.pow,
    random: Math.random,
    round: Math.round,
    sign: Math.sign,
    sin: Math.sin,
    sqrt: Math.sqrt,
    tan: Math.tan,
    trunc: Math.trunc,
});

// Token types
const TOKEN = {
    NUMBER: 'NUMBER',
    STRING: 'STRING',
    IDENT: 'IDENT',
    OP: 'OP',
    LPAREN: '(',
    RPAREN: ')',
    LBRACKET: '[',
    RBRACKET: ']',
    COMMA: ',',
    DOT: '.',
    QUESTION: '?',
    COLON: ':',
    NOT: '!',
    EOF: 'EOF',
};

/**
 * Tokenize an expression string.
 * @param {string} expr
 * @returns {Array<{type: string, value: *}>}
 */
function tokenize(expr) {
    const tokens = [];
    let i = 0;

    while (i < expr.length) {
        const ch = expr[i];

        // Whitespace
        if (/\s/.test(ch)) { i++; continue; }

        // Numbers (including decimals)
        if (/\d/.test(ch) || (ch === '.' && i + 1 < expr.length && /\d/.test(expr[i + 1]))) {
            let num = '';
            while (i < expr.length && /[\d.eE+-]/.test(expr[i])) {
                // Handle e+/e- but not standalone +/-
                if ((expr[i] === '+' || expr[i] === '-') && num.length > 0 &&
                    !/[eE]/.test(num[num.length - 1])) break;
                num += expr[i++];
            }
            tokens.push({ type: TOKEN.NUMBER, value: parseFloat(num) });
            continue;
        }

        // Strings (single or double quoted)
        if (ch === '"' || ch === "'") {
            const quote = ch;
            let str = '';
            i++; // skip opening quote
            while (i < expr.length && expr[i] !== quote) {
                if (expr[i] === '\\' && i + 1 < expr.length) {
                    i++;
                    switch (expr[i]) {
                        case 'n': str += '\n'; break;
                        case 't': str += '\t'; break;
                        case '\\': str += '\\'; break;
                        default: str += expr[i];
                    }
                } else {
                    str += expr[i];
                }
                i++;
            }
            i++; // skip closing quote
            tokens.push({ type: TOKEN.STRING, value: str });
            continue;
        }

        // Identifiers and keywords
        if (/[a-zA-Z_$]/.test(ch)) {
            let ident = '';
            while (i < expr.length && /[a-zA-Z0-9_$]/.test(expr[i])) {
                ident += expr[i++];
            }
            tokens.push({ type: TOKEN.IDENT, value: ident });
            continue;
        }

        // Multi-character operators
        const twoChar = expr.slice(i, i + 3);
        if (twoChar === '===' || twoChar === '!==') {
            tokens.push({ type: TOKEN.OP, value: twoChar });
            i += 3;
            continue;
        }
        const pair = expr.slice(i, i + 2);
        if (['==', '!=', '<=', '>=', '&&', '||', '**'].includes(pair)) {
            tokens.push({ type: TOKEN.OP, value: pair });
            i += 2;
            continue;
        }

        // Single-character tokens
        const singles = {
            '(': TOKEN.LPAREN, ')': TOKEN.RPAREN,
            '[': TOKEN.LBRACKET, ']': TOKEN.RBRACKET,
            ',': TOKEN.COMMA, '.': TOKEN.DOT,
            '?': TOKEN.QUESTION, ':': TOKEN.COLON,
            '!': TOKEN.NOT,
        };
        if (singles[ch]) {
            tokens.push({ type: singles[ch], value: ch });
            i++;
            continue;
        }

        // Arithmetic and comparison operators
        if (['+', '-', '*', '/', '%', '<', '>'].includes(ch)) {
            tokens.push({ type: TOKEN.OP, value: ch });
            i++;
            continue;
        }

        // Unknown character - skip
        i++;
    }

    tokens.push({ type: TOKEN.EOF, value: null });
    return tokens;
}

/**
 * Recursive-descent parser/evaluator.
 */
class ExpressionEvaluator {
    constructor(tokens, context) {
        this.tokens = tokens;
        this.pos = 0;
        this.context = context;
    }

    peek() { return this.tokens[this.pos]; }
    advance() { return this.tokens[this.pos++]; }

    expect(type) {
        const tok = this.advance();
        if (tok.type !== type) {
            throw new Error(`Expected ${type}, got ${tok.type} (${tok.value})`);
        }
        return tok;
    }

    // Entry point: ternary (lowest precedence)
    evaluate() {
        return this.ternary();
    }

    // condition ? a : b
    ternary() {
        let result = this.logicalOr();
        if (this.peek().type === TOKEN.QUESTION) {
            this.advance(); // skip ?
            const consequent = this.ternary();
            this.expect(TOKEN.COLON);
            const alternate = this.ternary();
            result = result ? consequent : alternate;
        }
        return result;
    }

    // ||
    logicalOr() {
        let left = this.logicalAnd();
        while (this.peek().type === TOKEN.OP && this.peek().value === '||') {
            this.advance();
            const right = this.logicalAnd();
            left = left || right;
        }
        return left;
    }

    // &&
    logicalAnd() {
        let left = this.equality();
        while (this.peek().type === TOKEN.OP && this.peek().value === '&&') {
            this.advance();
            const right = this.equality();
            left = left && right;
        }
        return left;
    }

    // ==, !=, ===, !==
    equality() {
        let left = this.comparison();
        while (this.peek().type === TOKEN.OP &&
               ['==', '!=', '===', '!=='].includes(this.peek().value)) {
            const op = this.advance().value;
            const right = this.comparison();
            switch (op) {
                case '==': left = left == right; break;  // eslint-disable-line eqeqeq
                case '!=': left = left != right; break;  // eslint-disable-line eqeqeq
                case '===': left = left === right; break;
                case '!==': left = left !== right; break;
            }
        }
        return left;
    }

    // <, >, <=, >=
    comparison() {
        let left = this.addition();
        while (this.peek().type === TOKEN.OP &&
               ['<', '>', '<=', '>='].includes(this.peek().value)) {
            const op = this.advance().value;
            const right = this.addition();
            switch (op) {
                case '<': left = left < right; break;
                case '>': left = left > right; break;
                case '<=': left = left <= right; break;
                case '>=': left = left >= right; break;
            }
        }
        return left;
    }

    // +, -
    addition() {
        let left = this.multiplication();
        while (this.peek().type === TOKEN.OP &&
               ['+', '-'].includes(this.peek().value)) {
            const op = this.advance().value;
            const right = this.multiplication();
            left = op === '+' ? left + right : left - right;
        }
        return left;
    }

    // *, /, %
    multiplication() {
        let left = this.power();
        while (this.peek().type === TOKEN.OP &&
               ['*', '/', '%'].includes(this.peek().value)) {
            const op = this.advance().value;
            const right = this.power();
            switch (op) {
                case '*': left = left * right; break;
                case '/': left = right !== 0 ? left / right : 0; break;
                case '%': left = left % right; break;
            }
        }
        return left;
    }

    // **
    power() {
        let base = this.unary();
        if (this.peek().type === TOKEN.OP && this.peek().value === '**') {
            this.advance();
            const exp = this.power(); // right-associative
            base = Math.pow(base, exp);
        }
        return base;
    }

    // Unary: -, +, !
    unary() {
        const tok = this.peek();
        if (tok.type === TOKEN.OP && (tok.value === '-' || tok.value === '+')) {
            this.advance();
            const val = this.unary();
            return tok.value === '-' ? -val : +val;
        }
        if (tok.type === TOKEN.NOT) {
            this.advance();
            return !this.unary();
        }
        return this.callOrMember();
    }

    // Function calls and member access: obj.prop, obj[expr], fn(args)
    callOrMember() {
        let obj = this.primary();

        while (true) {
            if (this.peek().type === TOKEN.DOT) {
                this.advance();
                const prop = this.expect(TOKEN.IDENT).value;
                obj = obj != null ? obj[prop] : undefined;
            } else if (this.peek().type === TOKEN.LBRACKET) {
                this.advance();
                const index = this.evaluate();
                this.expect(TOKEN.RBRACKET);
                obj = obj != null ? obj[index] : undefined;
            } else if (this.peek().type === TOKEN.LPAREN) {
                this.advance();
                const args = [];
                if (this.peek().type !== TOKEN.RPAREN) {
                    args.push(this.evaluate());
                    while (this.peek().type === TOKEN.COMMA) {
                        this.advance();
                        args.push(this.evaluate());
                    }
                }
                this.expect(TOKEN.RPAREN);
                if (typeof obj === 'function') {
                    obj = obj(...args);
                } else {
                    throw new Error(`${obj} is not a function`);
                }
            } else {
                break;
            }
        }

        return obj;
    }

    // Primary: literals, identifiers, parenthesized expressions
    primary() {
        const tok = this.peek();

        // Number literal
        if (tok.type === TOKEN.NUMBER) {
            this.advance();
            return tok.value;
        }

        // String literal
        if (tok.type === TOKEN.STRING) {
            this.advance();
            return tok.value;
        }

        // Identifier (variable or built-in)
        if (tok.type === TOKEN.IDENT) {
            this.advance();
            const name = tok.value;

            // Check context first, then safe globals
            if (name in this.context) return this.context[name];
            if (name in SAFE_GLOBALS) return SAFE_GLOBALS[name];

            return undefined;
        }

        // Parenthesized expression
        if (tok.type === TOKEN.LPAREN) {
            this.advance();
            const val = this.evaluate();
            this.expect(TOKEN.RPAREN);
            return val;
        }

        // Array literal [a, b, c]
        if (tok.type === TOKEN.LBRACKET) {
            this.advance();
            const arr = [];
            if (this.peek().type !== TOKEN.RBRACKET) {
                arr.push(this.evaluate());
                while (this.peek().type === TOKEN.COMMA) {
                    this.advance();
                    arr.push(this.evaluate());
                }
            }
            this.expect(TOKEN.RBRACKET);
            return arr;
        }

        throw new Error(`Unexpected token: ${tok.type} (${tok.value})`);
    }
}

/**
 * Evaluate a JavaScript expression string with the given variable context.
 *
 * @param {string} expr - The expression to evaluate
 * @param {object} [context={}] - Variables available in the expression
 * @returns {*} The result of the expression
 *
 * @example
 *   evaluateExpression('x + y', { x: 10, y: 5 })  // 15
 *   evaluateExpression('Math.sin(PI / 2)')          // 1
 *   evaluateExpression('x > 0 ? x : -x', { x: -3 }) // 3
 */
function evaluateExpression(expr, context = {}) {
    try {
        if (!expr || typeof expr !== 'string') return undefined;

        const trimmed = expr.trim();
        if (!trimmed) return undefined;

        const tokens = tokenize(trimmed);
        const evaluator = new ExpressionEvaluator(tokens, context);
        return evaluator.evaluate();
    } catch (err) {
        logger.error(`Expression evaluation error: "${expr}" - ${err.message}`);
        return undefined;
    }
}

module.exports = evaluateExpression;
module.exports.tokenize = tokenize;
module.exports.ExpressionEvaluator = ExpressionEvaluator;
module.exports.SAFE_GLOBALS = SAFE_GLOBALS;
