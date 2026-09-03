/**
 * Parse GRBL settings response: $0=10 (step pulse, usec)
 */
class GrblLineParserResultSettings {
    static parse(line) {
        const match = line.match(/^\$(\d+)=(.+)$/);
        if (!match) return null;

        const setting = Number(match[1]);
        const value = match[2];

        return {
            type: 'settings',
            payload: {
                name: `$${setting}`,
                setting,
                value: parseFloat(value),
                rawValue: value,
            },
        };
    }
}

module.exports = GrblLineParserResultSettings;
