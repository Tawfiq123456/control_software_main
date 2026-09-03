/**
 * Parse GRBL status report: <State|MPos:...|WPos:...|Bf:...|FS:...|Ov:...|Pn:...>
 *
 * Reference: gSender GrblLineParserResultStatus.js (GPLv3, Sienci Labs Inc.)
 */

class GrblLineParserResultStatus {
    static parse(line) {
        const r = line.match(/^<(.+)>$/);
        if (!r) return null;

        const payload = {};
        const pattern = /[a-zA-Z]+(:[a-zA-Z0-9.\-]+(,[0-9.\-[a]+){0,5})?/g;
        const params = r[1].match(pattern);
        if (!params || params.length === 0) return null;

        const result = {};

        // Active state (first token)
        const states = (params.shift() || '').split(':');
        payload.activeState = states[0] || '';
        payload.subState = Number(states[1] || 0);

        for (const param of params) {
            const nv = param.match(/^(.+):(.+)/);
            if (nv) {
                result[nv[1]] = nv[2].split(',');
            }
        }

        const AXES = ['x', 'y', 'z', 'a', 'b', 'c'];

        // Machine Position
        if (result.MPos) {
            payload.mpos = {};
            for (let i = 0; i < result.MPos.length; i++) {
                payload.mpos[AXES[i]] = result.MPos[i];
            }
        }

        // Work Position
        if (result.WPos) {
            payload.wpos = {};
            for (let i = 0; i < result.WPos.length; i++) {
                payload.wpos[AXES[i]] = result.WPos[i];
            }
        }

        // Work Coordinate Offset
        if (result.WCO) {
            payload.wco = {};
            for (let i = 0; i < result.WCO.length; i++) {
                payload.wco[AXES[i]] = result.WCO[i];
            }
        }

        // Buffer state (v0.9)
        if (result.Buf) {
            payload.buf = payload.buf || {};
            payload.buf.planner = Number(result.Buf[0] || 0);
        }
        if (result.RX) {
            payload.buf = payload.buf || {};
            payload.buf.rx = Number(result.RX[0] || 0);
        }

        // Buffer state (v1.1): Bf:15,128
        if (result.Bf) {
            payload.buf = payload.buf || {};
            payload.buf.planner = Number(result.Bf[0] || 0);
            payload.buf.rx = Number(result.Bf[1] || 0);
        }

        // Line number
        if (result.Ln) {
            payload.ln = Number(result.Ln[0] || 0);
        }

        // Feed rate (v0.9)
        if (result.F) {
            payload.feedrate = Number(result.F[0] || 0);
        }

        // Feed + Spindle (v1.1)
        if (result.FS) {
            payload.feedrate = Number(result.FS[0] || 0);
            payload.spindle = Number(result.FS[1] || 0);
        }

        // Input pin state
        payload.pinState = {};
        if (result.Pn) {
            const pins = result.Pn[0] || '';
            pins.split('').forEach(pin => {
                payload.pinState[pin] = true;
            });
        }

        // Override values: Ov:100,100,100
        if (result.Ov) {
            payload.ov = result.Ov.map(v => Number(v));
            payload.ovTimestamp = Date.now();
        }

        // Accessory state: A:SFM
        if (result.A) {
            payload.accessoryState = result.A[0] || '';
        }

        return {
            type: 'status',
            payload,
        };
    }
}

module.exports = GrblLineParserResultStatus;
