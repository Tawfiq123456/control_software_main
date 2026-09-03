/**
 * GrblHalController - grblHAL-specific controller extensions.
 *
 * Extends GrblController with:
 *   - Send-response streaming protocol (instead of character-counting)
 *   - Additional grblHAL-specific commands (single-axis homing, etc.)
 *   - Extended status report parsing
 *   - grblHAL-specific settings handling
 *
 * Reference: gSender GrblHalController (GPLv3, Sienci Labs Inc.)
 */
const { GrblController } = require('../GRBLController');
const { Sender, SP_TYPE_SEND_RESPONSE } = require('../Sender');

class GrblHalController extends GrblController {
    constructor() {
        super('GrblHAL');

        // Override sender to use send-response protocol (simpler, more reliable for HAL)
        this.sender = new Sender(SP_TYPE_SEND_RESPONSE);

        // Re-wire sender events since we replaced the sender
        this._setupSenderEvents();
    }

    /**
     * Extended command map for grblHAL-specific commands.
     */
    get _commands() {
        const baseCommands = super._commands;

        return {
            ...baseCommands,

            // Single-axis homing (grblHAL extension)
            'homing:x': () => this.writeln('$HX'),
            'homing:y': () => this.writeln('$HY'),
            'homing:z': () => this.writeln('$HZ'),
            'homing:a': () => this.writeln('$HA'),

            // Extended status report (grblHAL)
            'extendedStatus': () => this.writeImmediate('\x87'),

            // Tool change complete
            'toolchange:complete': () => this.writeln('$T'),

            // grblHAL specific settings
            'settings:extended': () => this.writeln('$+'),
            'settings:all': () => this.writeln('$$'),
            'settings:groups': () => this.writeln('$I+'),

            // Spindle select (grblHAL with multiple spindles)
            'spindle:select': (id) => this.writeln(`$32=${id}`),

            // E-stop handling
            'estop:clear': () => {
                this.writeImmediate('\x18'); // Soft reset
                setTimeout(() => this.writeln('$X'), 500); // Unlock
            },
        };
    }
}

module.exports = { GrblHalController };
