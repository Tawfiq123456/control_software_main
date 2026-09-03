/**
 * Parse GRBL parameter responses:
 *   [G54:0.000,0.000,0.000]  -- WCS offsets
 *   [G28:0.000,0.000,0.000]  -- Pre-defined positions
 *   [G92:0.000,0.000,0.000]  -- G92 offset
 *   [TLO:0.000]              -- Tool length offset
 *   [PRB:0.000,0.000,0.000:1] -- Probe result
 */
class GrblLineParserResultParameters {
    static parse(line) {
        // WCS / predefined positions: [G54:x,y,z] [G28:x,y,z] [G30:x,y,z] [G92:x,y,z]
        const wcsMatch = line.match(/^\[(G5[4-9]|G28|G30|G92):(.+)\]$/);
        if (wcsMatch) {
            const name = wcsMatch[1];
            const values = wcsMatch[2].split(',').map(Number);
            const axes = ['x', 'y', 'z', 'a', 'b', 'c'];
            const coords = {};
            for (let i = 0; i < values.length; i++) {
                coords[axes[i]] = values[i];
            }
            return {
                type: 'parameters',
                payload: { name, value: coords },
            };
        }

        // Tool length offset: [TLO:0.000]
        const tloMatch = line.match(/^\[TLO:(.+)\]$/);
        if (tloMatch) {
            return {
                type: 'parameters',
                payload: { name: 'TLO', value: parseFloat(tloMatch[1]) },
            };
        }

        // Probe result: [PRB:x,y,z:success]
        const prbMatch = line.match(/^\[PRB:(.+):(\d)\]$/);
        if (prbMatch) {
            const values = prbMatch[1].split(',').map(Number);
            const axes = ['x', 'y', 'z', 'a', 'b', 'c'];
            const coords = {};
            for (let i = 0; i < values.length; i++) {
                coords[axes[i]] = values[i];
            }
            return {
                type: 'parameters',
                payload: {
                    name: 'PRB',
                    value: coords,
                    probeSuccess: prbMatch[2] === '1',
                },
            };
        }

        return null;
    }
}

module.exports = GrblLineParserResultParameters;
