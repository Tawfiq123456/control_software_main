/**
 * Parse GRBL option response: [OPT:V,L,N]
 * V = option codes, L = block buffer size, N = rx buffer size
 */
class GrblLineParserResultOption {
    static parse(line) {
        const match = line.match(/^\[OPT:(.+)\]$/);
        if (!match) return null;

        const parts = match[1].split(',');
        return {
            type: 'option',
            payload: {
                optionCodes: parts[0] || '',
                blockBufferSize: Number(parts[1]) || 0,
                rxBufferSize: Number(parts[2]) || 0,
            },
        };
    }
}

module.exports = GrblLineParserResultOption;
