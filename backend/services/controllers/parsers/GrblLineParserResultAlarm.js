/**
 * Parse GRBL 'ALARM:X' response.
 */
class GrblLineParserResultAlarm {
    static parse(line) {
        const match = line.match(/^ALARM:(.+)$/);
        if (!match) return null;

        const code = Number(match[1]);
        return {
            type: 'alarm',
            payload: {
                code,
                message: match[1],
            },
        };
    }
}

module.exports = GrblLineParserResultAlarm;
