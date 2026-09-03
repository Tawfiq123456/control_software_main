/**
 * Parse GRBL 'ok' response.
 */
class GrblLineParserResultOk {
    static parse(line) {
        if (line !== 'ok') return null;
        return { type: 'ok', payload: {} };
    }
}

module.exports = GrblLineParserResultOk;
