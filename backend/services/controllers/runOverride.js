/**
 * runOverride - Feed/rapid/spindle override percentage calculator.
 *
 * Calculates the realtime command bytes needed to reach a target
 * override percentage from the current value, using GRBL's
 * coarse (±10%) and fine (±1%) adjustment commands.
 *
 * Reference: gSender runOverride.js (GPLv3, Sienci Labs Inc.)
 */
const {
    GRBL_REALTIME_COMMANDS,
} = require('./constants');

/**
 * Calculate the sequence of realtime commands to reach a target override.
 *
 * @param {number} current - Current override percentage (e.g. 100)
 * @param {number} target - Target override percentage (e.g. 150)
 * @param {string} type - 'feed' | 'rapid' | 'spindle'
 * @returns {string[]} Array of realtime command bytes to send
 */
function calculateOverrideCommands(current, target, type) {
    if (current === target) return [];

    const commands = [];

    if (type === 'rapid') {
        // Rapid only supports 25%, 50%, 100%
        if (target >= 100) {
            commands.push(GRBL_REALTIME_COMMANDS.RAPID_OVR_RESET);
        } else if (target >= 50) {
            commands.push(GRBL_REALTIME_COMMANDS.RAPID_OVR_MEDIUM);
        } else {
            commands.push(GRBL_REALTIME_COMMANDS.RAPID_OVR_LOW);
        }
        return commands;
    }

    // Feed and spindle use coarse (±10%) and fine (±1%) adjustments
    const resetCmd = type === 'feed'
        ? GRBL_REALTIME_COMMANDS.FEED_OVR_RESET
        : GRBL_REALTIME_COMMANDS.SPINDLE_OVR_RESET;
    const coarsePlus = type === 'feed'
        ? GRBL_REALTIME_COMMANDS.FEED_OVR_COARSE_PLUS
        : GRBL_REALTIME_COMMANDS.SPINDLE_OVR_COARSE_PLUS;
    const coarseMinus = type === 'feed'
        ? GRBL_REALTIME_COMMANDS.FEED_OVR_COARSE_MINUS
        : GRBL_REALTIME_COMMANDS.SPINDLE_OVR_COARSE_MINUS;
    const finePlus = type === 'feed'
        ? GRBL_REALTIME_COMMANDS.FEED_OVR_FINE_PLUS
        : GRBL_REALTIME_COMMANDS.SPINDLE_OVR_FINE_PLUS;
    const fineMinus = type === 'feed'
        ? GRBL_REALTIME_COMMANDS.FEED_OVR_FINE_MINUS
        : GRBL_REALTIME_COMMANDS.SPINDLE_OVR_FINE_MINUS;

    // Strategy: reset to 100% first, then adjust to target
    // This is simpler and more reliable than incremental adjustment
    if (target === 100) {
        commands.push(resetCmd);
        return commands;
    }

    commands.push(resetCmd);

    let value = 100;
    const diff = target - value;

    // Coarse adjustments (±10%)
    const coarseSteps = Math.floor(Math.abs(diff) / 10);
    const coarseCmd = diff > 0 ? coarsePlus : coarseMinus;
    for (let i = 0; i < coarseSteps; i++) {
        commands.push(coarseCmd);
    }
    value += (diff > 0 ? 1 : -1) * coarseSteps * 10;

    // Fine adjustments (±1%)
    const fineSteps = Math.abs(target - value);
    const fineCmd = target > value ? finePlus : fineMinus;
    for (let i = 0; i < fineSteps; i++) {
        commands.push(fineCmd);
    }

    return commands;
}

/**
 * Clamp an override value to valid range.
 * Feed/spindle: 10-200%, Rapid: 25%, 50%, 100%
 *
 * @param {number} value
 * @param {string} type - 'feed' | 'rapid' | 'spindle'
 * @returns {number}
 */
function clampOverride(value, type) {
    if (type === 'rapid') {
        if (value >= 100) return 100;
        if (value >= 50) return 50;
        return 25;
    }
    return Math.max(10, Math.min(200, Math.round(value)));
}

module.exports = {
    calculateOverrideCommands,
    clampOverride,
};
