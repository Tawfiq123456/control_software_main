/**
 * Parse GRBL help response: [HLP:...]
 */
class GrblLineParserResultHelp {
    static parse(line) {
        const match = line.match(/^\[HLP:(.+)\]$/);
        if (!match) return null;
        return {
            type: 'help',
            payload: { message: match[1] },
        };
    }
}

module.exports = GrblLineParserResultHelp;
