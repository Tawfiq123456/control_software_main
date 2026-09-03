/**
 * GrblRunner - Parses all GRBL serial responses and maintains machine state.
 *
 * Handles:
 *   - Status reports: <State|MPos:...|WPos:...|Bf:...|FS:...|Ov:...|Pn:...>
 *   - ok / error responses
 *   - Alarm messages
 *   - Feedback messages [MSG:...]
 *   - Settings ($0=10, etc.)
 *   - Parser state ($G response)
 *   - Build info ($I response)
 *   - Work coordinates ($# response)
 *   - Startup lines ($N response)
 *   - Probe results [PRB:...]
 *
 * Emits: status, ok, error, alarm, parserstate, parameters, feedback,
 *        settings, startup, others
 *
 * Reference: gSender GrblRunner.js (GPLv3, Sienci Labs Inc.)
 */
const { EventEmitter } = require('events');
const {
    ACTIVE_STATES,
    GRBL_ERRORS,
    GRBL_ALARMS,
    GRBL_SETTINGS,
} = require('./constants');

class GrblRunner extends EventEmitter {
    constructor() {
        super();

        this.state = {
            status: {
                activeState: 'Idle',
                mpos: { x: 0, y: 0, z: 0, a: 0 },
                wpos: { x: 0, y: 0, z: 0, a: 0 },
                wco: { x: 0, y: 0, z: 0, a: 0 },
                ov: { feed: 100, rapid: 100, spindle: 100 },
                buf: { planner: 0, rx: 0 },
                feedrate: 0,
                spindle: 0,
                spindleDirection: 'M5',
                pinState: '',
                probeActive: false,
            },
            parserstate: {
                modal: {
                    motion: 'G0',
                    wcs: 'G54',
                    plane: 'G17',
                    units: 'G21',
                    distance: 'G90',
                    feedrate: 'G94',
                    program: 'M0',
                    spindle: 'M5',
                    coolant: 'M9',
                },
                tool: 0,
                feedrate: 0,
                spindle: 0,
            },
        };

        this.settings = {
            version: '',
            parameters: {},
            settings: {},
        };

        // Track whether WCO has been received (for computing WPos from MPos)
        this._hasWco = false;
    }

    /**
     * Parse a line of data from the GRBL controller.
     * @param {string} line - Trimmed line from serial
     */
    parse(line) {
        if (!line) return;

        // Status report: <...>
        if (line.startsWith('<') && line.endsWith('>')) {
            this._parseStatusReport(line);
            return;
        }

        // ok response
        if (line === 'ok') {
            this.emit('ok');
            return;
        }

        // Error response
        if (line.startsWith('error:')) {
            const code = parseInt(line.slice(6), 10);
            const errorInfo = GRBL_ERRORS[code] || { message: `Unknown error ${code}`, description: '' };
            this.emit('error', { code, ...errorInfo, raw: line });
            return;
        }

        // Alarm
        if (line.startsWith('ALARM:')) {
            const code = parseInt(line.slice(6), 10);
            const alarmInfo = GRBL_ALARMS[code] || { message: `Unknown alarm ${code}`, description: '' };
            this.state.status.activeState = 'Alarm';
            this.emit('alarm', { code, ...alarmInfo, raw: line });
            return;
        }

        // Feedback message [MSG:...]
        if (line.startsWith('[MSG:')) {
            const msg = line.slice(5, -1);
            this.emit('feedback', { type: 'msg', message: msg, raw: line });
            return;
        }

        // Parser state [GC:...]
        if (line.startsWith('[GC:')) {
            this._parseParserState(line);
            return;
        }

        // Probe result [PRB:...]
        if (line.startsWith('[PRB:')) {
            this._parseProbeResult(line);
            return;
        }

        // Work coordinate offsets [G54:...] [G55:...] etc.
        if (/^\[G5[4-9]:/.test(line) || /^\[G28:/.test(line) || /^\[G30:/.test(line) ||
            /^\[G92:/.test(line) || /^\[TLO:/.test(line)) {
            this._parseWorkCoordinate(line);
            return;
        }

        // Build info / version
        if (line.startsWith('[VER:') || line.startsWith('[OPT:')) {
            this._parseBuildInfo(line);
            return;
        }

        // Settings ($0=10)
        if (/^\$\d+=/.test(line)) {
            this._parseSetting(line);
            return;
        }

        // Startup line ($N0=...)
        if (/^\$N\d+=/.test(line)) {
            this.emit('startup', { raw: line });
            return;
        }

        // Grbl startup message
        if (line.includes('Grbl') || line.includes('grblHAL') || line.includes('FluidNC')) {
            this._parseStartupMessage(line);
            return;
        }

        // Everything else
        this.emit('others', { raw: line });
    }

    // ─── Status Report Parsing ───────────────────────────────────────

    _parseStatusReport(line) {
        const inner = line.slice(1, -1);
        const parts = inner.split('|');

        // First part is always the active state (may have sub-state like Hold:0)
        const statePart = parts[0];
        const colonIdx = statePart.indexOf(':');
        const activeState = colonIdx >= 0 ? statePart.slice(0, colonIdx) : statePart;
        const subState = colonIdx >= 0 ? parseInt(statePart.slice(colonIdx + 1), 10) : null;

        this.state.status.activeState = activeState;

        let hasMPos = false;
        let hasWPos = false;

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            const sepIdx = part.indexOf(':');
            if (sepIdx < 0) continue;

            const key = part.slice(0, sepIdx);
            const val = part.slice(sepIdx + 1);

            try {
                switch (key) {
                    case 'MPos': {
                        const coords = val.split(',').map(Number);
                        this.state.status.mpos = {
                            x: coords[0] || 0,
                            y: coords[1] || 0,
                            z: coords[2] || 0,
                            a: coords[3] || 0,
                        };
                        hasMPos = true;
                        break;
                    }
                    case 'WPos': {
                        const coords = val.split(',').map(Number);
                        this.state.status.wpos = {
                            x: coords[0] || 0,
                            y: coords[1] || 0,
                            z: coords[2] || 0,
                            a: coords[3] || 0,
                        };
                        hasWPos = true;
                        break;
                    }
                    case 'WCO': {
                        const coords = val.split(',').map(Number);
                        this.state.status.wco = {
                            x: coords[0] || 0,
                            y: coords[1] || 0,
                            z: coords[2] || 0,
                            a: coords[3] || 0,
                        };
                        this._hasWco = true;
                        break;
                    }
                    case 'Bf': {
                        const vals = val.split(',').map(Number);
                        this.state.status.buf = {
                            planner: vals[0] || 0,
                            rx: vals[1] || 0,
                        };
                        break;
                    }
                    case 'FS': {
                        const vals = val.split(',').map(Number);
                        this.state.status.feedrate = vals[0] || 0;
                        this.state.status.spindle = vals[1] || 0;
                        break;
                    }
                    case 'F': {
                        this.state.status.feedrate = Number(val) || 0;
                        break;
                    }
                    case 'Ov': {
                        const vals = val.split(',').map(Number);
                        this.state.status.ov = {
                            feed: vals[0] || 100,
                            rapid: vals[1] || 100,
                            spindle: vals[2] || 100,
                        };
                        break;
                    }
                    case 'Pn': {
                        this.state.status.pinState = val;
                        this.state.status.probeActive = val.includes('P');
                        break;
                    }
                    case 'A': {
                        // Accessory state: S=spindle CW, C=spindle CCW, F=flood, M=mist
                        if (val.includes('S')) this.state.status.spindleDirection = 'M3';
                        else if (val.includes('C')) this.state.status.spindleDirection = 'M4';
                        else this.state.status.spindleDirection = 'M5';
                        break;
                    }
                    default:
                        // Ignore unknown fields (grblHAL extensions)
                        break;
                }
            } catch (_) {
                // Ignore parse errors on individual fields
            }
        }

        // Compute WPos from MPos + WCO if only MPos was reported
        if (hasMPos && !hasWPos && this._hasWco) {
            this.state.status.wpos = {
                x: this.state.status.mpos.x - this.state.status.wco.x,
                y: this.state.status.mpos.y - this.state.status.wco.y,
                z: this.state.status.mpos.z - this.state.status.wco.z,
                a: this.state.status.mpos.a - this.state.status.wco.a,
            };
        }

        // Compute MPos from WPos + WCO if only WPos was reported
        if (hasWPos && !hasMPos && this._hasWco) {
            this.state.status.mpos = {
                x: this.state.status.wpos.x + this.state.status.wco.x,
                y: this.state.status.wpos.y + this.state.status.wco.y,
                z: this.state.status.wpos.z + this.state.status.wco.z,
                a: this.state.status.wpos.a + this.state.status.wco.a,
            };
        }

        this.emit('status', {
            activeState,
            subState,
            mpos: { ...this.state.status.mpos },
            wpos: { ...this.state.status.wpos },
            wco: { ...this.state.status.wco },
            buf: { ...this.state.status.buf },
            ov: { ...this.state.status.ov },
            feedrate: this.state.status.feedrate,
            spindle: this.state.status.spindle,
            spindleDirection: this.state.status.spindleDirection,
            pinState: this.state.status.pinState,
        });
    }

    // ─── Parser State ────────────────────────────────────────────────

    _parseParserState(line) {
        // [GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]
        const inner = line.slice(4, -1);
        const words = inner.split(' ');

        for (const word of words) {
            if (word.startsWith('T')) {
                this.state.parserstate.tool = parseInt(word.slice(1), 10) || 0;
            } else if (word.startsWith('F')) {
                this.state.parserstate.feedrate = parseFloat(word.slice(1)) || 0;
            } else if (word.startsWith('S')) {
                this.state.parserstate.spindle = parseFloat(word.slice(1)) || 0;
            } else if (word.startsWith('G') || word.startsWith('M')) {
                this._setModalGroup(word);
            }
        }

        this.emit('parserstate', { ...this.state.parserstate });
    }

    _setModalGroup(word) {
        const { modal } = this.state.parserstate;
        if (['G0', 'G1', 'G2', 'G3', 'G38.2', 'G38.3', 'G38.4', 'G38.5', 'G80'].includes(word)) {
            modal.motion = word;
        } else if (['G54', 'G55', 'G56', 'G57', 'G58', 'G59'].includes(word)) {
            modal.wcs = word;
        } else if (['G17', 'G18', 'G19'].includes(word)) {
            modal.plane = word;
        } else if (['G20', 'G21'].includes(word)) {
            modal.units = word;
        } else if (['G90', 'G91'].includes(word)) {
            modal.distance = word;
        } else if (['G93', 'G94'].includes(word)) {
            modal.feedrate = word;
        } else if (['M0', 'M1', 'M2', 'M30'].includes(word)) {
            modal.program = word;
        } else if (['M3', 'M4', 'M5'].includes(word)) {
            modal.spindle = word;
        } else if (['M7', 'M8', 'M9'].includes(word)) {
            modal.coolant = word;
        }
    }

    // ─── Probe Result ────────────────────────────────────────────────

    _parseProbeResult(line) {
        // [PRB:0.000,0.000,0.000:1]
        const inner = line.slice(5, -1);
        const colonIdx = inner.lastIndexOf(':');
        const coordStr = colonIdx >= 0 ? inner.slice(0, colonIdx) : inner;
        const success = colonIdx >= 0 ? inner.slice(colonIdx + 1) === '1' : false;
        const coords = coordStr.split(',').map(Number);

        this.emit('parameters', {
            type: 'PRB',
            value: {
                x: coords[0] || 0,
                y: coords[1] || 0,
                z: coords[2] || 0,
                success,
            },
            raw: line,
        });
    }

    // ─── Work Coordinate Offsets ─────────────────────────────────────

    _parseWorkCoordinate(line) {
        // [G54:0.000,0.000,0.000]
        const inner = line.slice(1, -1);
        const colonIdx = inner.indexOf(':');
        if (colonIdx < 0) return;

        const name = inner.slice(0, colonIdx);
        const coords = inner.slice(colonIdx + 1).split(',').map(Number);

        const value = {
            x: coords[0] || 0,
            y: coords[1] || 0,
            z: coords[2] || 0,
        };

        this.settings.parameters[name] = value;
        this.emit('parameters', { type: name, value, raw: line });
    }

    // ─── Build Info ──────────────────────────────────────────────────

    _parseBuildInfo(line) {
        if (line.startsWith('[VER:')) {
            const ver = line.slice(5, -1);
            this.settings.version = ver;
        }
        this.emit('others', { raw: line });
    }

    // ─── Settings ────────────────────────────────────────────────────

    _parseSetting(line) {
        // $0=10
        const match = line.match(/^\$(\d+)=(.+)$/);
        if (!match) return;

        const key = parseInt(match[1], 10);
        const value = parseFloat(match[2]);
        const meta = GRBL_SETTINGS[key] || {};

        this.settings.settings[key] = value;
        this.emit('settings', {
            key,
            value,
            message: meta.message || `Setting $${key}`,
            units: meta.units || '',
            description: meta.description || '',
            raw: line,
        });
    }

    // ─── Startup Message ─────────────────────────────────────────────

    _parseStartupMessage(line) {
        let firmwareType = 'Grbl';
        let firmwareVersion = '';

        if (line.includes('grblHAL')) {
            firmwareType = 'GrblHAL';
            const match = line.match(/grblHAL\s+([\d.]+)/i);
            if (match) firmwareVersion = match[1];
        } else if (line.includes('FluidNC')) {
            firmwareType = 'FluidNC';
            const match = line.match(/FluidNC\s+v?([\d.]+)/i);
            if (match) firmwareVersion = match[1];
        } else if (line.includes('Grbl')) {
            const match = line.match(/Grbl\s+([\d.]+\w*)/);
            if (match) firmwareVersion = match[1];
        }

        this.settings.version = `${firmwareType} ${firmwareVersion}`;
        this.emit('startup', {
            firmwareType,
            firmwareVersion,
            raw: line,
        });
    }

    // ─── Helper Methods ──────────────────────────────────────────────

    isIdle() {
        return this.state.status.activeState === 'Idle';
    }

    isAlarm() {
        return this.state.status.activeState === 'Alarm';
    }

    isRunning() {
        return this.state.status.activeState === 'Run';
    }

    isHold() {
        return this.state.status.activeState === 'Hold';
    }

    getMachinePosition() {
        return { ...this.state.status.mpos };
    }

    getWorkPosition() {
        return { ...this.state.status.wpos };
    }

    getModalGroup() {
        return { ...this.state.parserstate.modal };
    }

    getOverrides() {
        return { ...this.state.status.ov };
    }

    getBufferState() {
        return { ...this.state.status.buf };
    }

    hasSettings() {
        return Object.keys(this.settings.settings).length > 0;
    }

    getSetting(key) {
        return this.settings.settings[key];
    }
}

module.exports = { GrblRunner };
