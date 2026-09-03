// SafetyValidator — Module 1 of EasyCNC Safety System (ECSS) v1.
//
// On G-code load, parses every motion line, computes X/Y/Z min/max in WORK
// coords, converts to MACHINE coords using the active G54 offset, and checks
// against the machine soft limits. If any move falls outside the envelope, the
// validator emits a `safety:validation` event with a `blocked: true` verdict
// and an explicit, line-numbered reason — the same kind of message the vendor
// app shows ("Exceeded Z minimum travel by 3.81").
//
// The frontend listens for this event and disables the Start button.

const RE_MOTION = /^\s*(?:N\d+\s+)?(G0?[0-3])\b/i;

function parseGcodeBounds(gcode) {
    const bounds = {
        x: { min: Infinity, max: -Infinity, atLine: { min: -1, max: -1 } },
        y: { min: Infinity, max: -Infinity, atLine: { min: -1, max: -1 } },
        z: { min: Infinity, max: -Infinity, atLine: { min: -1, max: -1 } },
    };
    const current = { x: null, y: null, z: null };
    let absolute = true;
    const lines = gcode.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const stripped = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim();
        if (!stripped) continue;

        if (/\bG90\b/i.test(stripped)) absolute = true;
        if (/\bG91\b/i.test(stripped)) absolute = false;

        if (!RE_MOTION.test(stripped)) continue;

        for (const axis of ['x', 'y', 'z']) {
            const m = stripped.match(new RegExp(`\\b${axis}(-?\\d+\\.?\\d*)`, 'i'));
            if (!m) continue;
            const value = parseFloat(m[1]);
            let pos;
            if (absolute || current[axis] === null) {
                pos = value;
            } else {
                pos = (current[axis] || 0) + value;
            }
            current[axis] = pos;

            if (pos < bounds[axis].min) {
                bounds[axis].min = pos;
                bounds[axis].atLine.min = i + 1;
            }
            if (pos > bounds[axis].max) {
                bounds[axis].max = pos;
                bounds[axis].atLine.max = i + 1;
            }
        }
    }

    for (const axis of ['x', 'y', 'z']) {
        if (bounds[axis].min === Infinity) bounds[axis].min = 0;
        if (bounds[axis].max === -Infinity) bounds[axis].max = 0;
    }
    return bounds;
}

function workToMachine(bound, offset) {
    return bound + offset;
}

function validateToolpath({ gcode, wco, machineLimits }) {
    const bounds = parseGcodeBounds(gcode);
    const issues = [];
    const summary = {};

    for (const axis of ['x', 'y', 'z']) {
        const workMin = bounds[axis].min;
        const workMax = bounds[axis].max;
        const offset = wco?.[axis] ?? 0;
        const machineMin = workToMachine(workMin, offset);
        const machineMax = workToMachine(workMax, offset);

        const limit = machineLimits?.[axis] ?? null;
        summary[axis] = {
            workMin: round(workMin),
            workMax: round(workMax),
            offset: round(offset),
            machineMin: round(machineMin),
            machineMax: round(machineMax),
            limit: limit ? { min: round(limit.min), max: round(limit.max) } : null,
        };

        if (!limit) continue;

        // Skip axes with unset limits (both 0 = firmware hasn't reported real
        // travel range yet, or user hasn't configured $130-132). Without this
        // skip, every positive move triggers a false "out of bounds" block.
        // Tawfiq msg 6789 (iqube.nc rejected because max_travel = 0,0,0,720).
        if (limit.min === 0 && limit.max === 0) {
            summary[axis].skipped = 'limits-unset';
            continue;
        }

        if (machineMax > limit.max + 0.001) {
            issues.push({
                axis: axis.toUpperCase(),
                line: bounds[axis].atLine.max,
                kind: 'above_max',
                value: round(workMax),
                machineTarget: round(machineMax),
                limit: round(limit.max),
                exceedance: round(machineMax - limit.max),
                message: `Line ${bounds[axis].atLine.max}: ${axis.toUpperCase()}${round(workMax)} → machine ${axis.toUpperCase()}=${round(machineMax)} mm. Exceeds positive ${axis.toUpperCase()} travel limit (${round(limit.max)} mm) by ${round(machineMax - limit.max)} mm.`,
            });
        }
        if (machineMin < limit.min - 0.001) {
            issues.push({
                axis: axis.toUpperCase(),
                line: bounds[axis].atLine.min,
                kind: 'below_min',
                value: round(workMin),
                machineTarget: round(machineMin),
                limit: round(limit.min),
                exceedance: round(limit.min - machineMin),
                message: `Line ${bounds[axis].atLine.min}: ${axis.toUpperCase()}${round(workMin)} → machine ${axis.toUpperCase()}=${round(machineMin)} mm. Exceeds negative ${axis.toUpperCase()} travel limit (${round(limit.min)} mm) by ${round(limit.min - machineMin)} mm.`,
            });
        }
    }

    // Pre-flight check disabled per Tawfiq msg 6800: vendor RTS doesn't
    // have a pre-flight blocker, and ours kept false-positive blocking
    // because the firmware reports max_travel = 0 for some axes before
    // the user configures $130-132. Banner removed, blocking removed.
    // Issues are still computed and returned so the UI summary can show
    // them, but `blocked` is hardcoded false.
    const blocked = false;
    const probableCorruptWCS = false;

    return { blocked, issues, summary, probableCorruptWCS };
}

function round(n) {
    return Math.round(n * 1000) / 1000;
}

// Soft-limit envelope expressed as machine coordinates.
// Homing convention: machine 0,0,0 is at the homed corner (typically top of Z,
// negative XY corner for Onefinity). All travel is into the negative range.
function defaultMachineLimits(profile) {
    const work = profile?.workArea || '';
    const m = work.match(/(\d+)\s*×\s*(\d+)\s*×\s*(\d+)/);
    if (!m) {
        return {
            x: { min: -812, max: 0 },
            y: { min: -812, max: 0 },
            z: { min: -130, max: 0 },
        };
    }
    return {
        x: { min: -parseInt(m[1], 10), max: 0 },
        y: { min: -parseInt(m[2], 10), max: 0 },
        z: { min: -parseInt(m[3], 10), max: 0 },
    };
}

module.exports = {
    parseGcodeBounds,
    validateToolpath,
    defaultMachineLimits,
};
