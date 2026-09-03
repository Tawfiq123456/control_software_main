/**
 * Parse GRBL version response: [VER:1.1h.20190825:]
 */
class GrblLineParserResultVersion {
    static parse(line) {
        const match = line.match(/^\[VER:(.+)\]$/);
        if (!match) return null;

        const parts = match[1].split(':');
        return {
            type: 'version',
            payload: {
                version: parts[0] || '',
                comment: parts[1] || '',
            },
        };
    }
}

module.exports = GrblLineParserResultVersion;
