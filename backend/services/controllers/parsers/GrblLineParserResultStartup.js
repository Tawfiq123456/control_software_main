/**
 * Parse GRBL startup message: Grbl X.Xx ['$' for help]
 * Also matches grblHAL variants.
 */
class GrblLineParserResultStartup {
    static parse(line) {
        // Standard: Grbl 1.1h ['$' for help]
        // grblHAL:  grblHAL 1.1f ['$' for help]
        const match = line.match(/^(Grbl|grblHAL)\s*([\d.]+[a-zA-Z]?)\s*(\[.+\])?/i);
        if (!match) return null;

        return {
            type: 'startup',
            payload: {
                firmware: match[1],
                version: match[2],
                message: match[3] || '',
            },
        };
    }
}

module.exports = GrblLineParserResultStartup;
