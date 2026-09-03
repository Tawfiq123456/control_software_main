/**
 * Controller factory: creates the appropriate controller based on detected firmware type.
 *
 * Supports:
 *   - 'Grbl' / 'FluidNC' -> GrblController (character-counting protocol)
 *   - 'GrblHAL' -> GrblHalController (send-response protocol, extended commands)
 *   - 'RTS' -> RTSController (Buildbotics/RealtimeCNC protocol)
 *   - 'Generic' -> GenericController (raw serial passthrough, no protocol)
 *
 * Usage:
 *   const controller = createController('GrblHAL');
 *   controller.bind(connection);
 */
const { GrblController } = require('../GRBLController');
const { GrblHalController } = require('./GrblHalController');
const { RTSController } = require('./RTSController');
const { GenericController } = require('./GenericController');
const { RSPController } = require('./RSPController');
const { FIRMWARE_GRBL, FIRMWARE_GRBLHAL, FIRMWARE_FLUIDNC, FIRMWARE_RTS, FIRMWARE_RSP, FIRMWARE_GENERIC } = require('../Connection');

/**
 * Available controller classes keyed by firmware type.
 */
const CONTROLLER_CLASSES = {
    [FIRMWARE_GRBL]: GrblController,
    [FIRMWARE_GRBLHAL]: GrblHalController,
    [FIRMWARE_FLUIDNC]: GrblController, // FluidNC is grbl-compatible
    [FIRMWARE_RTS]: RTSController,       // RealtimeCNC RTS-1/RTS-2
    [FIRMWARE_RSP]: RSPController,       // RSP (fw_m3_control_sw) 0x7E-framed CRC32 protocol
    [FIRMWARE_GENERIC]: GenericController, // [GENERIC MODE] Unknown/proprietary firmware
};

/**
 * Create a controller instance for the given firmware type.
 * [GENERIC MODE] Falls back to GenericController instead of GrblController
 * when firmware type is unknown.
 * @param {string} [firmwareType='Generic'] - Detected firmware type
 * @returns {GrblController|GrblHalController|RTSController|RSPController|GenericController}
 */
function createController(firmwareType = FIRMWARE_GENERIC) {
    const ControllerClass = CONTROLLER_CLASSES[firmwareType] || GenericController;
    return new ControllerClass(firmwareType);
}

/**
 * Get the list of supported controller types.
 * @returns {string[]}
 */
function getSupportedControllers() {
    return Object.keys(CONTROLLER_CLASSES);
}

module.exports = {
    createController,
    getSupportedControllers,
    CONTROLLER_CLASSES,
    GrblController,
    GrblHalController,
    RTSController,
    RSPController,
    GenericController,
};
