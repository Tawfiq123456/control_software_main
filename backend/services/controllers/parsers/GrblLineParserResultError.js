/**
 * Parse GRBL 'error:X' response.
 */
class GrblLineParserResultError {
    static parse(line) {
        const match = line.match(/^error:(.+)$/);
        if (!match) return null;

        const code = Number(match[1]);
        return {
            type: 'error',
            payload: {
                code,
                message: match[1],
            },
        };
    }
}

module.exports = GrblLineParserResultError;
