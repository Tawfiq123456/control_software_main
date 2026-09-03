/**
 * Parse GRBL feedback messages:
 *   v0.9: [message]
 *   v1.1: [MSG:message]
 */
class GrblLineParserResultFeedback {
    static parse(line) {
        // v1.1 format
        let match = line.match(/^\[MSG:(.+)\]$/);
        if (match) {
            return {
                type: 'feedback',
                payload: { message: match[1] },
            };
        }

        // v0.9 format: any [...] that hasn't been caught by other parsers
        match = line.match(/^\[(.+)\]$/);
        if (match) {
            const content = match[1];
            // Skip if it looks like a parameter, version, help, etc.
            if (/^(G5[4-9]|G28|G30|G92|GC|TLO|PRB|HLP|VER|OPT|echo):/.test(content)) {
                return null;
            }
            return {
                type: 'feedback',
                payload: { message: content },
            };
        }

        return null;
    }
}

module.exports = GrblLineParserResultFeedback;
