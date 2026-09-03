/**
 * Homing - Homing configuration, location logic, and safe movement calculation.
 *
 * Supports four homing locations based on $23 (homing direction invert mask):
 *   FRONT_RIGHT  (0) → X-, Y+
 *   FRONT_LEFT   (1) → X+, Y+
 *   BACK_RIGHT   (2) → X-, Y-
 *   BACK_LEFT    (3) → X+, Y-
 *
 * Provides helpers for:
 *   - Determining homing location from $23 setting
 *   - Calculating maximum safe movement in any direction
 *   - Getting axis maximum positions
 *   - Checking if machine is at zero
 *
 * Reference: gSender homing.js (GPLv3, Sienci Labs Inc.)
 */

// ─── Constants ───────────────────────────────────────────────────

const HOMING_LOCATION = Object.freeze({
    FRONT_RIGHT: 'FRONT_RIGHT',
    FRONT_LEFT: 'FRONT_LEFT',
    BACK_RIGHT: 'BACK_RIGHT',
    BACK_LEFT: 'BACK_LEFT',
});

const POSITIVE_DIRECTION = 1;
const NEGATIVE_DIRECTION = -1;

// $23 mask → homing location mapping
// $23 bit 0 = X direction, bit 1 = Y direction
const HOMING_MASK_MAP = Object.freeze({
    0: HOMING_LOCATION.BACK_RIGHT,    // X-, Y- (default)
    1: HOMING_LOCATION.BACK_LEFT,     // X+, Y-
    2: HOMING_LOCATION.FRONT_RIGHT,   // X-, Y+
    3: HOMING_LOCATION.FRONT_LEFT,    // X+, Y+
});

// ─── Functions ───────────────────────────────────────────────────

/**
 * Determine homing location from $23 setting value.
 * @param {number} setting23 - Value of $23 (homing direction invert mask)
 * @returns {string} Homing location constant
 */
function getHomingLocation(setting23) {
    const mask = (setting23 || 0) & 0x03; // Only X and Y bits
    return HOMING_MASK_MAP[mask] || HOMING_LOCATION.BACK_RIGHT;
}

/**
 * Get the axis direction signs for the homing location.
 * Returns [xSign, ySign] where +1 = positive limit, -1 = negative limit.
 * @param {string} location - Homing location constant
 * @returns {[number, number]}
 */
function getHomingDirections(location) {
    switch (location) {
        case HOMING_LOCATION.FRONT_RIGHT:
            return [NEGATIVE_DIRECTION, POSITIVE_DIRECTION];
        case HOMING_LOCATION.FRONT_LEFT:
            return [POSITIVE_DIRECTION, POSITIVE_DIRECTION];
        case HOMING_LOCATION.BACK_RIGHT:
            return [NEGATIVE_DIRECTION, NEGATIVE_DIRECTION];
        case HOMING_LOCATION.BACK_LEFT:
            return [POSITIVE_DIRECTION, NEGATIVE_DIRECTION];
        default:
            return [NEGATIVE_DIRECTION, NEGATIVE_DIRECTION];
    }
}

/**
 * Get the axis maximum position directions based on homing mask.
 * Returns [xDir, yDir] indicating which direction the maximum travel is.
 * @param {number} setting23 - Value of $23
 * @returns {[number, number]}
 */
function getAxisMaximumLocation(setting23) {
    const location = getHomingLocation(setting23);
    const [xHome, yHome] = getHomingDirections(location);
    // Maximum travel is opposite to homing direction
    return [-xHome, -yHome];
}

/**
 * Calculate maximum safe movement distance in a given direction.
 *
 * @param {number} currentPos - Current position on the axis
 * @param {number} direction - Direction of movement (+1 or -1)
 * @param {number} homeDir - Direction of homing for this axis (+1 or -1)
 * @param {number} maxTravel - Maximum travel distance ($130/$131/$132)
 * @returns {number} Maximum safe distance (always positive)
 */
function determineMaxMovement(currentPos, direction, homeDir, maxTravel) {
    if (!maxTravel || maxTravel <= 0) return 0;

    // If homing is at positive limit, machine range is [0, -maxTravel]
    // If homing is at negative limit, machine range is [0, maxTravel]
    if (direction === POSITIVE_DIRECTION) {
        if (homeDir === POSITIVE_DIRECTION) {
            // Moving positive, home is at positive → limited by home position
            return Math.max(0, -currentPos);
        } else {
            // Moving positive, home is at negative → limited by max travel
            return Math.max(0, maxTravel + currentPos);
        }
    } else {
        if (homeDir === POSITIVE_DIRECTION) {
            // Moving negative, home is at positive → limited by max travel
            return Math.max(0, maxTravel + currentPos);
        } else {
            // Moving negative, home is at negative → limited by home position
            return Math.max(0, -currentPos);
        }
    }
}

/**
 * Check if the machine position is at zero (within tolerance).
 * @param {{ x: number, y: number, z: number }} mpos - Machine position
 * @param {number} [tolerance=0.01]
 * @returns {{ x: boolean, y: boolean, z: boolean }}
 */
function isMachineAtZero(mpos, tolerance = 0.01) {
    return {
        x: Math.abs(mpos.x) < tolerance,
        y: Math.abs(mpos.y) < tolerance,
        z: Math.abs(mpos.z) < tolerance,
    };
}

/**
 * Determine if homing has been completed by checking if the machine
 * reported a zero-flag in the response.
 * @param {string} response - Raw response line
 * @param {object} settings - GRBL settings object
 * @returns {boolean}
 */
function determineMachineZeroFlagSet(response, settings) {
    if (!response || !settings) return false;
    // After homing, GRBL reports position at 0,0,0 (or near it)
    // Check if $22 (homing cycle) is enabled
    if (!settings[22]) return false;
    return response.includes('MPos:0.000,0.000,0.000') ||
           response.includes('MPos:-0.000,-0.000,-0.000');
}

/**
 * Get safe jog limits for all axes based on current position and settings.
 * @param {{ x: number, y: number, z: number }} mpos - Current machine position
 * @param {object} settings - GRBL settings ($23, $130, $131, $132)
 * @returns {{ x: { min: number, max: number }, y: { min: number, max: number }, z: { min: number, max: number } }}
 */
function getSafeJogLimits(mpos, settings) {
    const setting23 = settings[23] || 0;
    const [xHome, yHome] = getHomingDirections(getHomingLocation(setting23));

    return {
        x: {
            min: -determineMaxMovement(mpos.x, NEGATIVE_DIRECTION, xHome, settings[130] || 0),
            max: determineMaxMovement(mpos.x, POSITIVE_DIRECTION, xHome, settings[130] || 0),
        },
        y: {
            min: -determineMaxMovement(mpos.y, NEGATIVE_DIRECTION, yHome, settings[131] || 0),
            max: determineMaxMovement(mpos.y, POSITIVE_DIRECTION, yHome, settings[131] || 0),
        },
        z: {
            min: -determineMaxMovement(mpos.z, NEGATIVE_DIRECTION, NEGATIVE_DIRECTION, settings[132] || 0),
            max: determineMaxMovement(mpos.z, POSITIVE_DIRECTION, NEGATIVE_DIRECTION, settings[132] || 0),
        },
    };
}

module.exports = {
    HOMING_LOCATION,
    POSITIVE_DIRECTION,
    NEGATIVE_DIRECTION,
    HOMING_MASK_MAP,
    getHomingLocation,
    getHomingDirections,
    getAxisMaximumLocation,
    determineMaxMovement,
    isMachineAtZero,
    determineMachineZeroFlagSet,
    getSafeJogLimits,
};
