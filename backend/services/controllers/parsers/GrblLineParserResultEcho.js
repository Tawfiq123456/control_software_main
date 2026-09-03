/**
 * Parse GRBL echo response: [echo:...]
 */
class GrblLineParserResultEcho {
    static parse(line) {
        const match = line.match(/^\[echo:(.+)\]$/i);
        if (!match) return null;
        return {
            type: 'echo',
            payload: { message: match[1] },
        };
    }
}

module.exports = GrblLineParserResultEcho;
