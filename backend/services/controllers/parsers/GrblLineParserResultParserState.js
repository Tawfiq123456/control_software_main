/**
 * Parse GRBL parser state response.
 * v0.9: [G0 G54 G17 G21 G90 G94 M0 M5 M9 T0 F0. S0.]
 * v1.1: [GC:G0 G54 G17 G21 G90 G94 M0 M5 M9 T0 F0. S0.]
 */

const MODAL_GROUPS = {
    motion: ['G0', 'G1', 'G2', 'G3', 'G38.2', 'G38.3', 'G38.4', 'G38.5', 'G80'],
    wcs: ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'],
    plane: ['G17', 'G18', 'G19'],
    units: ['G20', 'G21'],
    distance: ['G90', 'G91'],
    feedrate: ['G93', 'G94'],
    program: ['M0', 'M1', 'M2', 'M30'],
    spindle: ['M3', 'M4', 'M5'],
    coolant: ['M7', 'M8', 'M9'],
};

class GrblLineParserResultParserState {
    static parse(line) {
        // v1.1 format
        let match = line.match(/^\[GC:(.+)\]$/);
        if (!match) {
            // v0.9 format: starts with [ and contains G/M codes
            match = line.match(/^\[([GM].+)\]$/);
        }
        if (!match) return null;

        const words = match[1].split(/\s+/);
        const modal = {};
        let tool = 0;
        let feedrate = 0;
        let spindle = 0;

        for (const word of words) {
            if (word.startsWith('T')) {
                tool = Number(word.substring(1));
                continue;
            }
            if (word.startsWith('F')) {
                feedrate = parseFloat(word.substring(1));
                continue;
            }
            if (word.startsWith('S')) {
                spindle = parseFloat(word.substring(1));
                continue;
            }

            // Match to modal group
            for (const [group, modes] of Object.entries(MODAL_GROUPS)) {
                if (modes.includes(word)) {
                    modal[group] = word;
                    break;
                }
            }
        }

        return {
            type: 'parserstate',
            payload: { modal, tool, feedrate, spindle },
        };
    }
}

module.exports = GrblLineParserResultParserState;
