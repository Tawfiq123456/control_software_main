/**
 * GamepadService — backend-side jog relay for gamepad/joystick events.
 *
 * Gamepad input is read on the browser (Gamepad API) because that's where the
 * physical USB device is plugged in. The browser emits `gamepad:axis` and
 * `gamepad:button` events to the backend via Socket.IO; this service translates
 * them into `jog start` / `jog stop` / `jog continuous` commands on the active
 * controller.
 *
 * Bindings (configurable in Settings → Gamepad):
 *   axes:    { x: 0, y: 1, z: 3 }    // gamepad axis index per CNC axis
 *   buttons: { home: 8, estop: 9, cyclestart: 0, hold: 1, probe: 2, mistOn: 6 }
 *   deadzone: 0.15
 *   maxFeedrate: 3000  (mm/min)
 *   axisInvert: { x: false, y: true, z: false }
 *
 * Jogging model:
 *   Browser polls gamepad at 60 fps, sends throttled deltas. We accumulate and
 *   emit GRBL "$J=" jog-continuous commands every 80 ms while sticks are deflected,
 *   and a `M5`/cancel when they return to neutral.
 */
const { EventEmitter } = require('events');

const DEFAULT_BINDINGS = {
    axes:    { x: 0, y: 1, z: 3 },
    buttons: { home: 8, estop: 9, cyclestart: 0, hold: 1, probe: 2, mistOn: 6 },
    deadzone: 0.15,
    maxFeedrate: 3000,
    axisInvert: { x: false, y: true, z: false },
    enabled: false,
};

const JOG_INTERVAL_MS = 80;

class GamepadService extends EventEmitter {
    constructor({ configStore, io, logger, getController }) {
        super();
        this.configStore = configStore;
        this.io = io;
        this.logger = logger || console;
        this.getController = getController;     // () → active controller or null
        this.bindings = DEFAULT_BINDINGS;
        this.activeAxes = { x: 0, y: 0, z: 0 };
        this.jogTimer = null;
        this.lastJogSent = 0;
    }

    init() {
        const stored = this.configStore.get('gamepad.bindings');
        this.bindings = { ...DEFAULT_BINDINGS, ...(stored || {}) };
        this._broadcastBindings();
    }

    getBindings() { return this.bindings; }

    setBindings(b) {
        this.bindings = { ...DEFAULT_BINDINGS, ...b };
        this.configStore.set('gamepad.bindings', this.bindings);
        this._broadcastBindings();
    }

    /**
     * Frontend reports current axis values [-1..1].
     * Called many times per second; only acts if enabled.
     */
    onAxes(values) {
        if (!this.bindings.enabled) return;
        const { axes, deadzone, axisInvert } = this.bindings;
        const apply = (idx, inv) => {
            const v = values[idx];
            if (v === undefined) return 0;
            const sign = inv ? -1 : 1;
            return Math.abs(v) < deadzone ? 0 : sign * v;
        };
        this.activeAxes = {
            x: apply(axes.x, axisInvert.x),
            y: apply(axes.y, axisInvert.y),
            z: apply(axes.z, axisInvert.z),
        };
        const any = this.activeAxes.x || this.activeAxes.y || this.activeAxes.z;
        if (any && !this.jogTimer) this._startJogLoop();
        if (!any && this.jogTimer) this._stopJogLoop();
    }

    /** Single-shot button press from frontend. */
    onButton(index, pressed) {
        if (!this.bindings.enabled || !pressed) return;
        const b = this.bindings.buttons;
        const ctl = this.getController?.();
        if (!ctl) return;
        if (index === b.home)        return this._safeCmd(ctl, '$H');
        if (index === b.estop)       return this._safeCmd(ctl, '\x18');     // soft reset
        if (index === b.cyclestart)  return this._safeCmd(ctl, '~');
        if (index === b.hold)        return this._safeCmd(ctl, '!');
        if (index === b.mistOn)      return this._safeCmd(ctl, 'M7');
        if (index === b.probe)       this.emit('probe-request');
    }

    _startJogLoop() {
        this.jogTimer = setInterval(() => this._tick(), JOG_INTERVAL_MS);
        this._tick();
    }

    _stopJogLoop() {
        if (this.jogTimer) clearInterval(this.jogTimer);
        this.jogTimer = null;
        const ctl = this.getController?.();
        if (ctl) this._safeCmd(ctl, '\x85');     // GRBL jog-cancel
    }

    _tick() {
        const ctl = this.getController?.();
        if (!ctl) return;
        const { maxFeedrate } = this.bindings;
        // Use small per-tick distance proportional to stick magnitude so that
        // releasing the stick stops smoothly (jog-cancel above handles the abrupt one).
        const dist = 1.0; // mm per tick at full deflection
        const dx = this.activeAxes.x * dist;
        const dy = this.activeAxes.y * dist;
        const dz = this.activeAxes.z * dist;
        const mag = Math.hypot(dx, dy, dz);
        if (mag === 0) return;
        const feed = Math.max(50, Math.min(maxFeedrate, mag * maxFeedrate));
        const parts = ['$J=G91', 'G21'];
        if (Math.abs(dx) > 1e-3) parts.push(`X${dx.toFixed(3)}`);
        if (Math.abs(dy) > 1e-3) parts.push(`Y${dy.toFixed(3)}`);
        if (Math.abs(dz) > 1e-3) parts.push(`Z${dz.toFixed(3)}`);
        parts.push(`F${feed.toFixed(0)}`);
        this._safeCmd(ctl, parts.join(' '));
    }

    _safeCmd(ctl, line) {
        try {
            if (typeof ctl.write === 'function') ctl.write(line + '\n');
            else if (typeof ctl.command === 'function') ctl.command('gcode', line);
        } catch (e) {
            this.logger.warn?.(`[gamepad] cmd failed: ${e.message}`);
        }
    }

    _broadcastBindings() {
        this.io.emit('gamepad:bindings', this.bindings);
    }

    shutdown() {
        this._stopJogLoop();
    }
}

module.exports = { GamepadService };
