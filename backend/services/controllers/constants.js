/**
 * GRBL constants: active states, realtime commands, modal groups,
 * error codes, alarm codes, and settings metadata.
 *
 * Reference: gSender constants.js (GPLv3, Sienci Labs Inc.)
 * @see https://github.com/Sienci-Labs/gsender/blob/master/src/server/controllers/Grbl/constants.js
 */

// ─── Active States ───────────────────────────────────────────────

const GRBL_ACTIVE_STATE_IDLE = 'Idle';
const GRBL_ACTIVE_STATE_RUN = 'Run';
const GRBL_ACTIVE_STATE_HOLD = 'Hold';
const GRBL_ACTIVE_STATE_DOOR = 'Door';
const GRBL_ACTIVE_STATE_HOME = 'Home';
const GRBL_ACTIVE_STATE_SLEEP = 'Sleep';
const GRBL_ACTIVE_STATE_ALARM = 'Alarm';
const GRBL_ACTIVE_STATE_CHECK = 'Check';
const GRBL_ACTIVE_STATE_JOG = 'Jog';

const ACTIVE_STATES = Object.freeze({
    [GRBL_ACTIVE_STATE_IDLE]: 'idle',
    [GRBL_ACTIVE_STATE_RUN]: 'running',
    [GRBL_ACTIVE_STATE_HOLD]: 'paused',
    [GRBL_ACTIVE_STATE_DOOR]: 'paused',
    [GRBL_ACTIVE_STATE_HOME]: 'running',
    [GRBL_ACTIVE_STATE_SLEEP]: 'idle',
    [GRBL_ACTIVE_STATE_ALARM]: 'alarm',
    [GRBL_ACTIVE_STATE_CHECK]: 'idle',
    [GRBL_ACTIVE_STATE_JOG]: 'running',
});

// ─── Realtime Commands ───────────────────────────────────────────

const GRBL_REALTIME_COMMANDS = Object.freeze({
    CYCLE_START: '~',
    FEED_HOLD: '!',
    STATUS_REPORT: '?',
    SOFT_RESET: '\x18',
    JOG_CANCEL: '\x85',
    SAFETY_DOOR: '\x84',
    FEED_OVR_RESET: '\x90',
    FEED_OVR_COARSE_PLUS: '\x91',
    FEED_OVR_COARSE_MINUS: '\x92',
    FEED_OVR_FINE_PLUS: '\x93',
    FEED_OVR_FINE_MINUS: '\x94',
    RAPID_OVR_RESET: '\x95',
    RAPID_OVR_MEDIUM: '\x96',
    RAPID_OVR_LOW: '\x97',
    SPINDLE_OVR_RESET: '\x99',
    SPINDLE_OVR_COARSE_PLUS: '\x9A',
    SPINDLE_OVR_COARSE_MINUS: '\x9B',
    SPINDLE_OVR_FINE_PLUS: '\x9C',
    SPINDLE_OVR_FINE_MINUS: '\x9D',
    SPINDLE_OVR_STOP: '\x9E',
    COOLANT_FLOOD_TOGGLE: '\xA0',
    COOLANT_MIST_TOGGLE: '\xA1',
});

// ─── Workflow States ─────────────────────────────────────────────

const WORKFLOW_STATE_IDLE = 'idle';
const WORKFLOW_STATE_RUNNING = 'running';
const WORKFLOW_STATE_PAUSED = 'paused';

// ─── Sender Protocols ────────────────────────────────────────────

const SP_TYPE_SEND_RESPONSE = 0;
const SP_TYPE_CHAR_COUNTING = 1;

// ─── Modal Groups ────────────────────────────────────────────────

const MODAL_GROUPS = Object.freeze({
    motion: ['G0', 'G1', 'G2', 'G3', 'G38.2', 'G38.3', 'G38.4', 'G38.5', 'G80'],
    wcs: ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'],
    plane: ['G17', 'G18', 'G19'],
    units: ['G20', 'G21'],
    distance: ['G90', 'G91'],
    feedrate: ['G93', 'G94'],
    program: ['M0', 'M1', 'M2', 'M30'],
    spindle: ['M3', 'M4', 'M5'],
    coolant: ['M7', 'M8', 'M9'],
});

// ─── Error Codes ─────────────────────────────────────────────────

const GRBL_ERRORS = Object.freeze({
    1: { message: 'Expected command letter', description: 'G-code word was missing a letter value.' },
    2: { message: 'Bad number format', description: 'Numeric value format is not valid or missing.' },
    3: { message: 'Invalid statement', description: 'Grbl \'$\' system command was not recognized.' },
    4: { message: 'Value < 0', description: 'Negative value received for an expected positive value.' },
    5: { message: 'Setting disabled', description: 'Homing cycle is not enabled via settings.' },
    6: { message: 'Value < 3 usec', description: 'Minimum step pulse time must be greater than 3usec.' },
    7: { message: 'EEPROM read fail', description: 'EEPROM read failed. Reset and restored to default values.' },
    8: { message: 'Not idle', description: 'Grbl \'$\' command cannot be used unless Grbl is IDLE.' },
    9: { message: 'G-code lock', description: 'G-code locked out during alarm or jog state.' },
    10: { message: 'Homing not enabled', description: 'Soft limits cannot be enabled without homing enabled.' },
    11: { message: 'Line overflow', description: 'Max characters per line exceeded.' },
    12: { message: 'Step rate > 30kHz', description: 'Grbl \'$\' setting value exceeds the maximum step rate.' },
    13: { message: 'Check door', description: 'Safety door detected as opened and door state initiated.' },
    14: { message: 'Line length exceeded', description: 'Build info or startup line exceeds EEPROM line length limit.' },
    15: { message: 'Travel exceeded', description: 'Jog target exceeds machine travel.' },
    16: { message: 'Invalid jog command', description: 'Jog command with no = or has prohibited g-code.' },
    17: { message: 'Setting disabled', description: 'Laser mode requires PWM output.' },
    20: { message: 'Unsupported command', description: 'Unsupported or invalid g-code command found.' },
    21: { message: 'Modal group violation', description: 'More than one g-code command from same modal group.' },
    22: { message: 'Undefined feed rate', description: 'Feed rate has not yet been set or is undefined.' },
    23: { message: 'Invalid gcode ID:23', description: 'G-code command in block requires an integer value.' },
    24: { message: 'Invalid gcode ID:24', description: 'Two G-code commands that both require the use of the XYZ axis words were detected.' },
    25: { message: 'Invalid gcode ID:25', description: 'A G-code word was repeated in the block.' },
    26: { message: 'Invalid gcode ID:26', description: 'A G-code command implicitly or explicitly requires XYZ axis words in the block, but none were found.' },
    27: { message: 'Invalid gcode ID:27', description: 'N line number value is not within the valid range of 1-9,999,999.' },
    28: { message: 'Invalid gcode ID:28', description: 'A G-code command was sent, but is missing some required P or L value words in the line.' },
    29: { message: 'Invalid gcode ID:29', description: 'Grbl supports six work coordinate systems G54-G59. G59.1, G59.2, and G59.3 are not supported.' },
    30: { message: 'Invalid gcode ID:30', description: 'The G53 G-code command requires either a G0 seek or G1 feed motion mode to be active.' },
    31: { message: 'Invalid gcode ID:31', description: 'There are unused axis words in the block and G80 motion mode cancel is active.' },
    32: { message: 'Invalid gcode ID:32', description: 'A G2 or G3 arc was commanded but there are no XYZ axis words in the selected plane to trace the arc.' },
    33: { message: 'Invalid gcode ID:33', description: 'The motion command has an invalid target. G2, G3 arcs are incorrectly defined.' },
    34: { message: 'Invalid gcode ID:34', description: 'A G2 or G3 arc, traced with the radius definition, had a mathematical error when computing the arc geometry.' },
    35: { message: 'Invalid gcode ID:35', description: 'A G2 or G3 arc, traced with the offset definition, is missing the IJK offset word.' },
    36: { message: 'Invalid gcode ID:36', description: 'There are unused, leftover G-code words that aren\'t used by any command in the block.' },
    37: { message: 'Invalid gcode ID:37', description: 'The G43.1 dynamic tool length offset command cannot apply an offset to an axis other than its configured axis.' },
    38: { message: 'Invalid gcode ID:38', description: 'Tool number greater than max supported value.' },
    60: { message: 'SD card failed', description: 'SD card mount failed.' },
    61: { message: 'SD card not found', description: 'SD card file open/read failed.' },
    62: { message: 'SD card busy', description: 'SD card directory listing failed.' },
    70: { message: 'Bluetooth failed', description: 'Bluetooth configuration failed.' },
});

// ─── Alarm Codes ─────────────────────────────────────────────────

const GRBL_ALARMS = Object.freeze({
    1: { message: 'Hard limit', description: 'Hard limit has been triggered. Position may be lost.' },
    2: { message: 'Soft limit', description: 'G-code motion target exceeds machine travel.' },
    3: { message: 'Abort during cycle', description: 'Reset while in motion. Position may be lost.' },
    4: { message: 'Probe fail', description: 'Probe is not in the expected initial state before starting probe cycle.' },
    5: { message: 'Probe fail', description: 'Probe did not contact the workpiece within the programmed travel.' },
    6: { message: 'Homing fail', description: 'Reset during active homing cycle.' },
    7: { message: 'Homing fail', description: 'Safety door was opened during active homing cycle.' },
    8: { message: 'Homing fail', description: 'Pull off travel failed to clear limit switch.' },
    9: { message: 'Homing fail', description: 'Could not find limit switch within search distance.' },
    10: { message: 'Homing required', description: 'Homing is required. Power cycle or $X to unlock.' },
    14: { message: 'Spindle at speed timeout', description: 'Spindle at speed timeout.' },
    17: { message: 'E-stop asserted', description: 'Emergency stop asserted - clear and reset.' },
});

// ─── GRBL Settings Metadata ──────────────────────────────────────

const GRBL_SETTINGS = Object.freeze({
    0: { message: 'Step pulse time', units: 'microseconds', description: 'Sets time length per step.' },
    1: { message: 'Step idle delay', units: 'milliseconds', description: 'Sets a short hold delay when stopping to let dynamics settle.' },
    2: { message: 'Step port invert', units: 'mask', description: 'Inverts the step signal.' },
    3: { message: 'Direction port invert', units: 'mask', description: 'Inverts the direction signal.' },
    4: { message: 'Step enable invert', units: 'boolean', description: 'Inverts the stepper driver enable pin signal.' },
    5: { message: 'Limit pins invert', units: 'boolean', description: 'Inverts the limit input pins.' },
    6: { message: 'Probe pin invert', units: 'boolean', description: 'Inverts the probe input pin signal.' },
    10: { message: 'Status report', units: 'mask', description: 'Determines what is included in the status report.' },
    11: { message: 'Junction deviation', units: 'mm', description: 'Sets how fast Grbl will move through consecutive motion line junctions.' },
    12: { message: 'Arc tolerance', units: 'mm', description: 'Sets the G2 and G3 arc tracing accuracy.' },
    13: { message: 'Report inches', units: 'boolean', description: 'Enables inch units when returning position reports.' },
    20: { message: 'Soft limits', units: 'boolean', description: 'Enables soft limits checks within machine travel.' },
    21: { message: 'Hard limits', units: 'boolean', description: 'Enables hard limits. Immediately halts motion and throws an alarm.' },
    22: { message: 'Homing cycle', units: 'boolean', description: 'Enables homing cycle.' },
    23: { message: 'Homing dir invert', units: 'mask', description: 'Homing searches for a switch in the positive direction.' },
    24: { message: 'Homing feed', units: 'mm/min', description: 'Feed rate to slowly engage limit switch.' },
    25: { message: 'Homing seek', units: 'mm/min', description: 'Seek rate to quickly find limit switch.' },
    26: { message: 'Homing debounce', units: 'milliseconds', description: 'Sets a short delay to debounce the homing switch signal.' },
    27: { message: 'Homing pull-off', units: 'mm', description: 'Retract distance after triggering switch.' },
    30: { message: 'Max spindle speed', units: 'RPM', description: 'Maximum spindle speed.' },
    31: { message: 'Min spindle speed', units: 'RPM', description: 'Minimum spindle speed.' },
    32: { message: 'Laser mode', units: 'boolean', description: 'Enables laser mode.' },
    100: { message: 'X steps/mm', units: 'steps/mm', description: 'X-axis travel resolution in steps per millimeter.' },
    101: { message: 'Y steps/mm', units: 'steps/mm', description: 'Y-axis travel resolution in steps per millimeter.' },
    102: { message: 'Z steps/mm', units: 'steps/mm', description: 'Z-axis travel resolution in steps per millimeter.' },
    103: { message: 'A steps/mm', units: 'steps/mm', description: 'A-axis travel resolution in steps per millimeter.' },
    110: { message: 'X max rate', units: 'mm/min', description: 'X-axis maximum rate.' },
    111: { message: 'Y max rate', units: 'mm/min', description: 'Y-axis maximum rate.' },
    112: { message: 'Z max rate', units: 'mm/min', description: 'Z-axis maximum rate.' },
    113: { message: 'A max rate', units: 'mm/min', description: 'A-axis maximum rate.' },
    120: { message: 'X acceleration', units: 'mm/sec^2', description: 'X-axis acceleration.' },
    121: { message: 'Y acceleration', units: 'mm/sec^2', description: 'Y-axis acceleration.' },
    122: { message: 'Z acceleration', units: 'mm/sec^2', description: 'Z-axis acceleration.' },
    123: { message: 'A acceleration', units: 'mm/sec^2', description: 'A-axis acceleration.' },
    130: { message: 'X max travel', units: 'mm', description: 'Maximum X-axis travel distance.' },
    131: { message: 'Y max travel', units: 'mm', description: 'Maximum Y-axis travel distance.' },
    132: { message: 'Z max travel', units: 'mm', description: 'Maximum Z-axis travel distance.' },
    133: { message: 'A max travel', units: 'mm', description: 'Maximum A-axis travel distance.' },
});

module.exports = {
    // Active states
    GRBL_ACTIVE_STATE_IDLE,
    GRBL_ACTIVE_STATE_RUN,
    GRBL_ACTIVE_STATE_HOLD,
    GRBL_ACTIVE_STATE_DOOR,
    GRBL_ACTIVE_STATE_HOME,
    GRBL_ACTIVE_STATE_SLEEP,
    GRBL_ACTIVE_STATE_ALARM,
    GRBL_ACTIVE_STATE_CHECK,
    GRBL_ACTIVE_STATE_JOG,
    ACTIVE_STATES,
    // Realtime commands
    GRBL_REALTIME_COMMANDS,
    // Workflow states
    WORKFLOW_STATE_IDLE,
    WORKFLOW_STATE_RUNNING,
    WORKFLOW_STATE_PAUSED,
    // Sender protocols
    SP_TYPE_SEND_RESPONSE,
    SP_TYPE_CHAR_COUNTING,
    // Modal groups
    MODAL_GROUPS,
    // Error/alarm/settings
    GRBL_ERRORS,
    GRBL_ALARMS,
    GRBL_SETTINGS,
};
