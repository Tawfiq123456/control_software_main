/**
 * GcodeToolpath - Parse G-code and generate 3D visualization data.
 *
 * Features:
 *   - Motion interpretation: G0/G1 (linear), G2/G3 (arcs)
 *   - Rotary axis support (A-axis)
 *   - Modal state tracking: units, distance mode, plane, WCS
 *   - Coordinate transformations: G92 offsets, WCO
 *   - Arc interpolation into line segments
 *
 * Output callbacks:
 *   addLine(modal, start, end)       - Linear move
 *   addArcCurve(modal, start, end, center) - Arc move
 *
 * Reference: gSender GcodeToolpath.js (GPLv3, Sienci Labs Inc.)
 */

const MODAL_DEFAULTS = {
    motion: 'G0',
    wcs: 'G54',
    plane: 'G17',
    units: 'G21',
    distance: 'G90',
    feedrate: 'G94',
    program: 'M0',
    spindle: 'M5',
    coolant: 'M9',
};

const ARC_SEGMENTS = 36;

class GcodeToolpath {
    /**
     * @param {object} [options]
     * @param {Function} [options.addLine] - (modal, v1, v2) => void
     * @param {Function} [options.addArcCurve] - (modal, v1, v2, v0) => void
     */
    constructor(options = {}) {
        this.addLine = options.addLine || (() => {});
        this.addArcCurve = options.addArcCurve || (() => {});

        this.modal = { ...MODAL_DEFAULTS };
        this.position = { x: 0, y: 0, z: 0, a: 0 };
        this.g92Offset = { x: 0, y: 0, z: 0, a: 0 };
        this.feedrate = 0;
        this.spindle = 0;
        this.tool = 0;
    }

    /**
     * Load and parse a full G-code string.
     * @param {string} gcode
     * @returns {GcodeToolpath} this (for chaining)
     */
    loadFromString(gcode) {
        if (!gcode) return this;
        const lines = gcode.split(/\r?\n/);
        for (const line of lines) {
            this.parseLine(line);
        }
        return this;
    }

    /**
     * Parse a single G-code line.
     * @param {string} rawLine
     */
    parseLine(rawLine) {
        const line = this._stripComments(rawLine).trim().toUpperCase();
        if (!line) return;

        const words = this._parseWords(line);
        if (words.length === 0) return;

        // Extract G/M codes and parameters
        const params = {};
        const codes = [];

        for (const [letter, value] of words) {
            if (letter === 'G' || letter === 'M') {
                codes.push(`${letter}${value}`);
            } else {
                params[letter] = value;
            }
        }

        // Update modal state from G/M codes
        for (const code of codes) {
            this._updateModal(code);
        }

        // Update feed rate, spindle, tool
        if (params.F !== undefined) this.feedrate = params.F;
        if (params.S !== undefined) this.spindle = params.S;
        if (params.T !== undefined) this.tool = params.T;

        // Handle motion commands
        if (this._hasAxisWords(params)) {
            this._executeMotion(params);
        }

        // Handle G92 offset
        if (codes.includes('G92')) {
            if (params.X !== undefined) this.g92Offset.x = this.position.x - params.X;
            if (params.Y !== undefined) this.g92Offset.y = this.position.y - params.Y;
            if (params.Z !== undefined) this.g92Offset.z = this.position.z - params.Z;
            if (params.A !== undefined) this.g92Offset.a = this.position.a - params.A;
        }
    }

    // ─── Motion Execution ────────────────────────────────────────

    _executeMotion(params) {
        const start = { ...this.position };
        const end = this._computeTarget(params);

        const motion = this.modal.motion;

        if (motion === 'G0' || motion === 'G1') {
            this.addLine(
                { ...this.modal },
                start,
                end
            );
        } else if (motion === 'G2' || motion === 'G3') {
            const center = this._computeArcCenter(start, end, params);
            this.addArcCurve(
                { ...this.modal },
                start,
                end,
                center
            );
        }

        this.position = end;
    }

    _computeTarget(params) {
        const isAbsolute = this.modal.distance === 'G90';
        const pos = { ...this.position };

        if (isAbsolute) {
            if (params.X !== undefined) pos.x = params.X + this.g92Offset.x;
            if (params.Y !== undefined) pos.y = params.Y + this.g92Offset.y;
            if (params.Z !== undefined) pos.z = params.Z + this.g92Offset.z;
            if (params.A !== undefined) pos.a = params.A + this.g92Offset.a;
        } else {
            if (params.X !== undefined) pos.x += params.X;
            if (params.Y !== undefined) pos.y += params.Y;
            if (params.Z !== undefined) pos.z += params.Z;
            if (params.A !== undefined) pos.a += params.A;
        }

        return pos;
    }

    _computeArcCenter(start, end, params) {
        // IJK offsets (relative to start)
        const i = params.I || 0;
        const j = params.J || 0;
        const k = params.K || 0;

        if (this.modal.plane === 'G17') {
            return { x: start.x + i, y: start.y + j, z: start.z };
        } else if (this.modal.plane === 'G18') {
            return { x: start.x + i, y: start.y, z: start.z + k };
        } else {
            return { x: start.x, y: start.y + j, z: start.z + k };
        }
    }

    // ─── Modal State ─────────────────────────────────────────────

    _updateModal(code) {
        const motionCodes = ['G0', 'G1', 'G2', 'G3', 'G38.2', 'G38.3', 'G38.4', 'G38.5', 'G80'];
        const wcsCodes = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'];
        const planeCodes = ['G17', 'G18', 'G19'];
        const unitsCodes = ['G20', 'G21'];
        const distanceCodes = ['G90', 'G91'];
        const feedrateCodes = ['G93', 'G94'];
        const programCodes = ['M0', 'M1', 'M2', 'M30'];
        const spindleCodes = ['M3', 'M4', 'M5'];
        const coolantCodes = ['M7', 'M8', 'M9'];

        if (motionCodes.includes(code)) this.modal.motion = code;
        else if (wcsCodes.includes(code)) this.modal.wcs = code;
        else if (planeCodes.includes(code)) this.modal.plane = code;
        else if (unitsCodes.includes(code)) this.modal.units = code;
        else if (distanceCodes.includes(code)) this.modal.distance = code;
        else if (feedrateCodes.includes(code)) this.modal.feedrate = code;
        else if (programCodes.includes(code)) this.modal.program = code;
        else if (spindleCodes.includes(code)) this.modal.spindle = code;
        else if (coolantCodes.includes(code)) this.modal.coolant = code;
    }

    // ─── Parsing Helpers ─────────────────────────────────────────

    _stripComments(line) {
        return line
            .replace(/;.*$/, '')
            .replace(/\([^)]*\)/g, '');
    }

    _parseWords(line) {
        const words = [];
        const regex = /([A-Z])([+-]?\d*\.?\d+)/g;
        let match;
        while ((match = regex.exec(line)) !== null) {
            words.push([match[1], parseFloat(match[2])]);
        }
        return words;
    }

    _hasAxisWords(params) {
        return params.X !== undefined || params.Y !== undefined ||
               params.Z !== undefined || params.A !== undefined ||
               params.I !== undefined || params.J !== undefined ||
               params.K !== undefined || params.R !== undefined;
    }

    // ─── Rotary Support ──────────────────────────────────────────

    /**
     * Rotate Y/Z coordinates around the A-axis.
     * @param {string} axis - 'y' or 'z'
     * @param {{ y: number, z: number, a: number }} coords
     * @returns {{ y: number, z: number, a: number }}
     */
    static rotateAxis(axis, coords) {
        const angle = (coords.a || 0) * Math.PI / 180;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        if (axis === 'y') {
            return {
                y: coords.z * sinA + coords.y * cosA,
                z: coords.z * cosA - coords.y * sinA,
                a: coords.a,
            };
        }
        return coords;
    }

    /**
     * Get the current modal state.
     */
    getModal() {
        return { ...this.modal };
    }

    /**
     * Get the current position.
     */
    getPosition() {
        return { ...this.position };
    }

    /**
     * Reset to initial state.
     */
    reset() {
        this.modal = { ...MODAL_DEFAULTS };
        this.position = { x: 0, y: 0, z: 0, a: 0 };
        this.g92Offset = { x: 0, y: 0, z: 0, a: 0 };
        this.feedrate = 0;
        this.spindle = 0;
        this.tool = 0;
    }
}

module.exports = { GcodeToolpath, MODAL_DEFAULTS };
