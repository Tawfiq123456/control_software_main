/**
 * ProbeStrategies — built-in probe wizards (gSender/AxioCNC parity).
 *
 * Each strategy is a pure function that returns:
 *   { gcode: string[], onResult: (probeReports) => wcsUpdates }
 *
 * The CNCEngine runs the gcode, captures `[PRB:x,y,z:1]` lines from the
 * controller into `probeReports`, then calls `onResult` to compute the WCS
 * offsets to apply (G10 L20 P<wcs> X.. Y.. Z..).
 *
 * Conventions:
 *   - All units mm (G21).
 *   - Probe feeds: fastFind = first contact, slowFind = re-approach.
 *   - Retract by `retraction` mm after each probe.
 *   - Touch-plate dimensions read from probeSettings.
 *
 * Strategies:
 *   - 'z-only'              Just set Z=0 on the touch plate top.
 *   - 'x-only', 'y-only'    Single-axis edge find against the plate side.
 *   - 'xyz-corner-front-left' / 'xyz-corner-front-right' /
 *     'xyz-corner-back-left' / 'xyz-corner-back-right'
 *                           Full 3-axis touch off (Z then X then Y).
 *   - 'center-bore'         Center-find inside a circular hole (4 probes).
 *   - 'center-boss'         Center-find around a square boss (4 probes).
 */
const STRATEGY_IDS = [
    'z-only',
    'x-only', 'y-only',
    'xyz-corner-front-left',
    'xyz-corner-front-right',
    'xyz-corner-back-left',
    'xyz-corner-back-right',
    'center-bore',
    'center-boss',
];

function listStrategies() {
    return STRATEGY_IDS.map(id => ({ id, name: humanName(id), corner: cornerOf(id) }));
}

function humanName(id) {
    return ({
        'z-only': 'Z-only (touch top)',
        'x-only': 'X-only (edge find)',
        'y-only': 'Y-only (edge find)',
        'xyz-corner-front-left':  'XYZ corner — front-left',
        'xyz-corner-front-right': 'XYZ corner — front-right',
        'xyz-corner-back-left':   'XYZ corner — back-left',
        'xyz-corner-back-right':  'XYZ corner — back-right',
        'center-bore': 'Bore center (inside hole)',
        'center-boss': 'Boss center (around stock)',
    })[id] || id;
}

function cornerOf(id) {
    const m = id.match(/corner-(.+)/);
    return m ? m[1] : null;
}

/**
 * Generate the G-code sequence for a strategy.
 *
 * @param {string} strategyId
 * @param {object} settings — probeSettings from ConfigStore
 * @param {string} wcs      — G54, G55, ..., G59
 */
function generate(strategyId, settings, wcs = 'G54') {
    const s = {
        blockThickness: 15,
        xyThickness: 10,
        zProbeDistance: 30,
        fastFind: 150,
        slowFind: 75,
        retraction: 2,
        ...(settings || {}),
    };

    switch (strategyId) {
        case 'z-only':                  return zOnly(s, wcs);
        case 'x-only':                  return axisOnly('X', s, wcs);
        case 'y-only':                  return axisOnly('Y', s, wcs);
        case 'xyz-corner-front-left':   return xyzCorner('front-left',  s, wcs);
        case 'xyz-corner-front-right':  return xyzCorner('front-right', s, wcs);
        case 'xyz-corner-back-left':    return xyzCorner('back-left',   s, wcs);
        case 'xyz-corner-back-right':   return xyzCorner('back-right',  s, wcs);
        case 'center-bore':             return centerBore(s, wcs);
        case 'center-boss':             return centerBoss(s, wcs);
        default: throw new Error(`Unknown strategy: ${strategyId}`);
    }
}

/** Helper: two-pass probe — fast, retract, slow. Returns lines + onResult. */
function probeTwoPass(axis, dir, dist, s) {
    const sign = dir > 0 ? '' : '-';
    return [
        `G91 G38.2 ${axis}${sign}${dist} F${s.fastFind}`,
        `G91 G0  ${axis}${dir > 0 ? '-' : ''}${s.retraction}`,
        `G91 G38.2 ${axis}${sign}${(s.retraction + 1).toFixed(2)} F${s.slowFind}`,
    ];
}

function zOnly(s, wcs) {
    return {
        id: 'z-only',
        gcode: [
            'G21', 'G90',
            ...probeTwoPass('Z', -1, s.zProbeDistance, s),
            `G10 L20 P${wcsIndex(wcs)} Z${s.blockThickness}`,
            `G91 G0 Z${s.retraction + 5}`,
            'G90',
        ],
        onResult: (reports) => {
            const last = reports[reports.length - 1];
            return last ? { Z: s.blockThickness } : null;
        },
    };
}

function axisOnly(axis, s, wcs) {
    // Assumes operator has positioned probe tip just outside the plate edge.
    return {
        id: `${axis.toLowerCase()}-only`,
        gcode: [
            'G21', 'G90',
            ...probeTwoPass(axis, 1, s.xyThickness * 2, s),
            `G10 L20 P${wcsIndex(wcs)} ${axis}${s.xyThickness}`,
            `G91 G0 ${axis}-${s.retraction + 2}`,
            'G90',
        ],
        onResult: (reports) => reports[reports.length - 1] ? { [axis]: s.xyThickness } : null,
    };
}

function xyzCorner(corner, s, wcs) {
    // Front-left = approach +X then +Y. Direction flips per corner.
    const [yPart, xPart] = corner.split('-');
    const xDir = xPart === 'left'  ? +1 : -1;
    const yDir = yPart === 'front' ? +1 : -1;
    const xSign = xDir > 0 ? '' : '-';
    const ySign = yDir > 0 ? '' : '-';
    const xRet  = xDir > 0 ? '-' : '';
    const yRet  = yDir > 0 ? '-' : '';

    return {
        id: `xyz-corner-${corner}`,
        gcode: [
            'G21', 'G90',
            // Z first.
            ...probeTwoPass('Z', -1, s.zProbeDistance, s),
            `G10 L20 P${wcsIndex(wcs)} Z${s.blockThickness}`,
            `G91 G0 Z${s.retraction + 5}`,
            // Approach in-XY toward the plate, drop down ~half plate, probe in X.
            `G91 G0 X${xSign}${(s.xyThickness + 5).toFixed(2)}`,
            `G91 G0 Z-${(s.retraction + s.blockThickness / 2).toFixed(2)}`,
            ...probeTwoPass('X', -xDir, s.xyThickness * 2, s),
            `G10 L20 P${wcsIndex(wcs)} X${xDir > 0 ? '-' : ''}${s.xyThickness}`,
            `G91 G0 X${xRet}${(s.retraction + s.xyThickness).toFixed(2)}`,
            // Now probe Y.
            `G91 G0 Y${ySign}${(s.xyThickness + 5).toFixed(2)}`,
            ...probeTwoPass('Y', -yDir, s.xyThickness * 2, s),
            `G10 L20 P${wcsIndex(wcs)} Y${yDir > 0 ? '-' : ''}${s.xyThickness}`,
            `G91 G0 Y${yRet}${(s.retraction + s.xyThickness).toFixed(2)}`,
            `G91 G0 Z${(s.blockThickness + 5).toFixed(2)}`,
            'G90',
        ],
        onResult: (reports) => {
            if (reports.length < 3) return null;
            const sX = xDir > 0 ? -1 : 1, sY = yDir > 0 ? -1 : 1;
            return { Z: s.blockThickness, X: sX * s.xyThickness, Y: sY * s.xyThickness };
        },
    };
}

function centerBore(s, wcs) {
    // Inside a circular hole — probe ±X then ±Y, average for center.
    const d = (s.boreApproximateDiameter || 20) / 2 + 2;
    return {
        id: 'center-bore',
        gcode: [
            'G21', 'G90',
            ...probeTwoPass('X', +1, d, s),
            `G91 G0 X-${s.retraction}`, 'G90',
            ...probeTwoPass('X', -1, d * 2, s),
            'G90',
            ...probeTwoPass('Y', +1, d, s),
            `G91 G0 Y-${s.retraction}`, 'G90',
            ...probeTwoPass('Y', -1, d * 2, s),
            'G90',
        ],
        onResult: (reports) => {
            if (reports.length < 4) return null;
            const xMid = (reports[0].X + reports[1].X) / 2;
            const yMid = (reports[2].Y + reports[3].Y) / 2;
            // Move to center & set X=0 Y=0.
            return { X: 0, Y: 0, moveTo: { X: xMid, Y: yMid } };
        },
    };
}

function centerBoss(s, wcs) {
    // Outside a square boss — drop down, approach from each side, average.
    const d = (s.bossApproximateSize || 30) + 5;
    return {
        id: 'center-boss',
        gcode: [
            'G21', 'G90',
            `G91 G0 X-${d}`,                      ...probeTwoPass('X', +1, d * 1.5, s),
            `G91 G0 X-${s.retraction}`, 'G90',
            `G91 G0 X${d * 2}`,                   ...probeTwoPass('X', -1, d * 1.5, s),
            'G90',
            `G91 G0 Y-${d}`,                      ...probeTwoPass('Y', +1, d * 1.5, s),
            `G91 G0 Y-${s.retraction}`, 'G90',
            `G91 G0 Y${d * 2}`,                   ...probeTwoPass('Y', -1, d * 1.5, s),
            'G90',
        ],
        onResult: (reports) => {
            if (reports.length < 4) return null;
            const xMid = (reports[0].X + reports[1].X) / 2;
            const yMid = (reports[2].Y + reports[3].Y) / 2;
            return { X: 0, Y: 0, moveTo: { X: xMid, Y: yMid } };
        },
    };
}

function wcsIndex(wcs) {
    return ({ G54: 1, G55: 2, G56: 3, G57: 4, G58: 5, G59: 6 })[wcs] || 1;
}

module.exports = {
    listStrategies,
    generate,
    STRATEGY_IDS,
};
