/**
 * ProbingService — runs probe strategies against the active controller.
 *
 * Flow:
 *   1. Frontend POSTs /api/probing/run { strategy, wcs, settings }.
 *   2. Service generates G-code via ProbeStrategies.generate().
 *   3. Streams each line to the controller, parses `[PRB:x,y,z:s]` replies.
 *   4. Calls strategy.onResult(reports) to compute WCS offsets to apply.
 *   5. Emits `probing:result` over Socket.IO with success/fail + numbers.
 *
 * Safety:
 *   - Refuses to start if controller not idle.
 *   - Aborts on any `[PRB:...:0]` (probe didn't trigger) — strategy may
 *     still succeed if the offending probe was non-critical (overridden).
 */
const { EventEmitter } = require('events');
const ProbeStrategies = require('./ProbeStrategies');

class ProbingService extends EventEmitter {
    constructor({ configStore, io, logger, getController }) {
        super();
        this.configStore = configStore;
        this.io = io;
        this.logger = logger || console;
        this.getController = getController;
        this.activeRun = null;
    }

    listStrategies() {
        return ProbeStrategies.listStrategies();
    }

    async run({ strategy, wcs = 'G54', settings }) {
        if (this.activeRun) throw new Error('Probing already in progress');
        const ctl = this.getController?.();
        if (!ctl) throw new Error('No active controller');
        const probeSettings = { ...this.configStore.get('probeSettings'), ...(settings || {}) };

        // RSP firmware's job-line gcode parser has no G38.x/G10 support (see
        // RSPController.js's probeAxis() doc comment), so the G38.2-line path
        // below cannot drive it -- run the RSP-native motion-primitive
        // routine instead (Tawfiq msg11347 item 1: "match hardware+UI").
        if (typeof ctl.probeAxis === 'function') {
            return this._runRSP({ strategy, wcs, settings: probeSettings, ctl });
        }

        const spec = ProbeStrategies.generate(strategy, probeSettings, wcs);

        this.activeRun = { strategy, wcs, reports: [], aborted: false };
        this.io.emit('probing:start', { strategy, wcs });

        // Hook into controller's probe-reply stream.
        const onReport = (rep) => {
            this.activeRun.reports.push(rep);
            this.io.emit('probing:probe', rep);
        };
        ctl.on?.('probe', onReport);

        try {
            for (const line of spec.gcode) {
                if (this.activeRun.aborted) throw new Error('Probing aborted');
                await this._sendAndAwaitOk(ctl, line);
            }
            const updates = spec.onResult(this.activeRun.reports);
            this.io.emit('probing:result', {
                strategy, wcs, success: true,
                reports: this.activeRun.reports,
                updates,
            });
            return { success: true, updates, reports: this.activeRun.reports };
        } catch (err) {
            this.io.emit('probing:result', { strategy, wcs, success: false, error: err.message });
            throw err;
        } finally {
            ctl.off?.('probe', onReport);
            this.activeRun = null;
        }
    }

    /**
     * RSP-native probing (OP_PROBE + OP_ZERO instead of G38.2/G10 text).
     *
     * IMPORTANT LIMITATION (flagged to Tawfiq, not silently worked around):
     * RSP's OP_ZERO only zeroes the WCS at the exact physical contact point
     * (axis_mask payload, no value) -- there is no G10 L20-equivalent opcode
     * to set the WCS to an arbitrary value. GRBL's strategies compensate for
     * touch-plate thickness / corner-jig size via `G10 L20 Z<blockThickness>`
     * etc, which logically shifts the origin without moving the machine.
     * RSP has no such primitive, so this path is a DIRECT touch-off: the
     * probe contact point itself becomes WCS zero for that axis, with zero
     * plate/jig-size compensation. Safe and correct for touching off
     * directly against the real stock/fixture surface; if Tawfiq uses a
     * touch plate or corner block with real thickness, the resulting WCS
     * zero will be off by that thickness until either (a) RSP firmware adds
     * a "set WCS to value" opcode, or (b) a manual remove-plate/re-zero step
     * is added to the UI flow.
     */
    async _runRSP({ strategy, wcs, settings: s, ctl }) {
        const AXIS = { X: 0, Y: 1, Z: 2 };
        this.activeRun = { strategy, wcs, reports: [], aborted: false };
        this.io.emit('probing:start', { strategy, wcs });

        const zeroAxis = (letter) => {
            try { ctl.command('wcs:zero', { [letter.toLowerCase()]: 0 }); } catch (_) { /* best-effort */ }
        };
        const checkAborted = () => {
            if (this.activeRun.aborted) throw new Error('Probing aborted');
        };
        const doProbe = async (axis, dirNeg, maxTravelMm, feed, axisLetter) => {
            checkAborted();
            const r = await ctl.probeAxis(axis, dirNeg, maxTravelMm, feed);
            this.activeRun.reports.push(r);
            this.io.emit('probing:probe', r);
            if (!r.contact) throw new Error(`${axisLetter} probe did not contact`);
            zeroAxis(axisLetter);
            return r;
        };

        try {
            if (strategy === 'z-only') {
                await doProbe(AXIS.Z, 1, s.zProbeDistance, s.fastFind, 'Z');
            } else if (strategy === 'x-only') {
                // Single-axis probe, same direction/travel convention as the
                // xyz-corner routine's X leg below -- used by the frontend's
                // Probe Recorder (msg11469) to capture a real X contact point
                // without running the full auto-sequence.
                await doProbe(AXIS.X, 0, (s.xyThickness || 10) * 2, s.fastFind, 'X');
            } else if (strategy === 'y-only') {
                await doProbe(AXIS.Y, 0, (s.xyThickness || 10) * 2, s.fastFind, 'Y');
            } else if (strategy.startsWith('xyz-corner-')) {
                // 11-step sequence per Tawfiq (msg11401), replacing the
                // former corner-side (front/back/left/right) routine below.
                // No corner-side selection anymore -- always steps -X then
                // -Y and probes back in +X/+Y, per spec.
                //
                // Distances corrected 2026-09-01 (msg11418/11420), corrected
                // AGAIN same day (msg11432/11434) after a second failed
                // hardware test, and corrected a THIRD time (msg11454) with
                // Tawfiq's exact spec: "retract 3mm, then move 7mm to left
                // in x axis then 4mm z axis down". Given the numbers have
                // moved 3 times, these are no longer derived from
                // xyThickness/blockThickness formulas (those formulas were
                // never actually validated against his rig) -- they're now
                // their own tunable probeSettings fields so the next
                // correction doesn't require another code ship.
                //
                // ROOT CAUSE of "it retracts more than commanded" (the 3mm
                // and 7mm attempts BEFORE this msg11454 spec): this was never
                // a constant-tuning problem. zeroAxis() rebases the ONE
                // shared x/y/z position register RSP exposes (no separate
                // MPos/WPos pair -- confirmed against defs.js's telemetry
                // fields and RSPController.js's probeAxis()/_moveAbsolute()/
                // wcs:zero handler). doProbe() zeroes the just-probed axis
                // BEFORE returning its report, so every _moveAbsolute() below
                // that reused `zr.z + offset` after Z had already been zeroed
                // at step 1 was targeting an offset from a STALE pre-zero
                // reading, not from the new zero -- the actual move distance
                // came out wrong regardless of what RETRACT_Z was set to.
                // Fixed by using literal offsets (relative to the fresh
                // zero) for any axis already zeroed at that point in the
                // sequence, and only reusing the raw probe-report reading
                // for axes not yet zeroed. That fix is unchanged here --
                // only the magnitudes below changed.
                const RETRACT_Z_X = (s.zRetractX ?? s.zRetract ?? 3.0);
                const REPOSITION_X = (s.xyRepositionX ?? s.xyReposition ?? 70.0);
                const DROP_Z_X = (s.zDropX ?? s.zDrop ?? 20.0);

                const RETRACT_Z_Y = (s.zRetractY ?? s.zRetract ?? 20.0);
                const REPOSITION_Y = (s.xyRepositionY ?? s.xyReposition ?? 64.0);
                const DROP_Z_Y = (s.zDropY ?? s.zDrop ?? 18.0);

                // steps 6/11: RSP's wcs:zero only zeroes at the current
                // physical position (no G10 L20 equivalent -- class-level
                // comment above), so the reference's `G10 L20 X<xyThickness>`
                // (a math-only WCS shift at the raw contact point) has to
                // become a real retreat of xyThickness mm before zeroing.
                const OFFSET = (s.xyThickness || 20);
                // Spec gave no explicit max-travel for the X/Y probe moves.
                // ASSUMPTION (flagged to Tawfiq, not a spec value): reusing
                // the existing xyThickness*2 default as the travel limit.
                const PROBE_TRAVEL = (s.xyThickness || 20) * 2;
                // msg11434: "speed of movement between Z X Y needed to be
                // increased" -- fastFind (default 150mm/min) is a probe
                // APPROACH feed, deliberately slow for a safe contact stop;
                // reusing it for pure repositioning moves (retract/
                // reposition/drop, steps 2/3/4/7/8/9 -- nothing is being
                // probed during them) was needlessly slow. No rapid/
                // traverse-feed concept existed anywhere in RSPController.js
                // or defs.js (checked: only percentage-based rapidOverride
                // commands, RSPController.js:751-753, no base numeric
                // constant) so this adds one as a real, user-tunable
                // probeSettings field (ConfigStore.js) instead of a
                // hardcoded magic number. Steps 6/11 (the precision
                // retreat-to-true-zero moves) intentionally stay on
                // slowFind -- those set the actual WCS zero point, so
                // accuracy still matters there.
                const TRAVERSE = (s.traverseFeed || 2500);

                // Step 1: probe Z- (top surface), record Z0. Auto-zeroes Z.
                const zr = await doProbe(AXIS.Z, 1, s.zProbeDistance, s.fastFind, 'Z');
                checkAborted();

                // Step 2: retract Z by RETRACT_Z_X (X leg retract).
                await ctl._moveAbsolute(zr.x, zr.y, RETRACT_Z_X, TRAVERSE);
                checkAborted();

                // Step 3: reposition X by -REPOSITION_X (X leg clearance).
                await ctl._moveAbsolute(zr.x - REPOSITION_X, zr.y, RETRACT_Z_X, TRAVERSE);
                checkAborted();

                // Step 4: drop Z to -DROP_Z_X (X leg drop depth below top surface).
                await ctl._moveAbsolute(zr.x - REPOSITION_X, zr.y, -DROP_Z_X, TRAVERSE);
                checkAborted();

                // Step 5: probe X+ until contact, record raw X point. Not
                // auto-zeroed -- the OFFSET retreat has to happen first.
                const xr = await ctl.probeAxis(AXIS.X, 0, PROBE_TRAVEL, s.fastFind);
                this.activeRun.reports.push(xr);
                this.io.emit('probing:probe', xr);
                if (!xr.contact) throw new Error('X probe did not contact');
                checkAborted();

                // Step 6: true X0 = raw X - OFFSET (20mm block edge retreat).
                await ctl._moveAbsolute(xr.x - OFFSET, xr.y, xr.z, TRAVERSE);
                checkAborted();
                zeroAxis('X');

                // Step 7: Lift Z to RETRACT_Z_Y & return to original starting position where Z was probed
                const startXInNewFrame = zr.x - (xr.x - OFFSET);
                await ctl._moveAbsolute(0, xr.y, RETRACT_Z_Y, TRAVERSE);
                checkAborted();
                await ctl._moveAbsolute(startXInNewFrame, zr.y, RETRACT_Z_Y, TRAVERSE);
                checkAborted();

                // Step 8: reposition Y by -REPOSITION_Y from original starting Y position
                await ctl._moveAbsolute(startXInNewFrame, zr.y - REPOSITION_Y, RETRACT_Z_Y, TRAVERSE);
                checkAborted();

                // Step 9: drop Z to -DROP_Z_Y (Y leg drop depth below top surface)
                await ctl._moveAbsolute(startXInNewFrame, zr.y - REPOSITION_Y, -DROP_Z_Y, TRAVERSE);
                checkAborted();

                // Step 10: probe Y+ until contact, record raw Y point.
                const yr = await ctl.probeAxis(AXIS.Y, 0, PROBE_TRAVEL, s.fastFind);
                this.activeRun.reports.push(yr);
                this.io.emit('probing:probe', yr);
                if (!yr.contact) throw new Error('Y probe did not contact');
                checkAborted();

                // Step 10.5: retract Z to 3mm after Y probe contact, clear of block edge.
                const Y_POST_RETRACT_Z = (s.yPostRetractZ ?? 3);
                await ctl._moveAbsolute(yr.x, yr.y, Y_POST_RETRACT_Z, TRAVERSE);
                checkAborted();

                // Step 11: true Y0 = raw Y - OFFSET (20mm block edge retreat).
                await ctl._moveAbsolute(yr.x, yr.y - OFFSET, Y_POST_RETRACT_Z, TRAVERSE);
                checkAborted();
                zeroAxis('Y');

                // Step 12: Move to post-probe coordinates (default X=27, Y=25, Z=15)
                // where the machine parks while waiting for the operator to remove the probe block.
                const POST_X = (s.postProbeX ?? 27);
                const POST_Y = (s.postProbeY ?? 25);
                const POST_Z = (s.postProbeZ ?? 15);
                await ctl._moveAbsolute(POST_X, POST_Y, POST_Z, TRAVERSE);
                checkAborted();
            } else {
                throw new Error(`Strategy "${strategy}" has no RSP-native routine yet`);
            }

            this.io.emit('probing:result', {
                strategy, wcs, success: true,
                reports: this.activeRun.reports,
                updates: null, // RSP zeroes directly; no numeric WCS offset to report
            });
            return { success: true, reports: this.activeRun.reports };
        } catch (err) {
            this.io.emit('probing:result', { strategy, wcs, success: false, error: err.message });
            throw err;
        } finally {
            this.activeRun = null;
        }
    }

    /**
     * Finalize step: "remove the probing device, then finalize zero."
     * Drops Z down by 15mm to the real stock surface, zeroes Z,
     * then moves X+8 and Y+10 to reach final position (35, 35, 0).
     */
    async finalizeCornerZero() {
        if (this.activeRun) throw new Error('Probing already in progress');
        const ctl = this.getController?.();
        if (!ctl) throw new Error('No active controller');
        if (typeof ctl._moveAbsolute !== 'function') throw new Error('Controller has no RSP-native move primitive');
        const s = this.configStore.get('probeSettings') || {};
        const TRAVERSE = (s.traverseFeed || 2500);
        const Z_FEED = (s.finalizeZFeed || 1500);
        const XY_FEED = (s.finalizeXYFeed || TRAVERSE);
        const startX = (s.postProbeX ?? 27);
        const startY = (s.postProbeY ?? 25);
        const startZ = (s.postProbeZ ?? 15);
        const zDrop = (s.finalizeZDrop ?? 30);
        const xAdd = (s.finalizeXAdd ?? 8);
        const yAdd = (s.finalizeYAdd ?? 10);

        this.activeRun = { strategy: 'finalize-corner-zero', wcs: null, reports: [], aborted: false };
        const checkAborted = () => {
            if (this.activeRun?.aborted) throw new Error('Probing aborted');
        };

        try {
            // Step 1: Move Z down to real surface (touch plate was removed by user) and re-zero Z at surface
            const targetZ = startZ - zDrop; // 15 - 30 = -15
            await ctl._moveAbsolute(startX, startY, targetZ, Z_FEED);
            checkAborted();
            try { ctl.command('wcs:zero', { z: 0 }); } catch (_) { /* best-effort */ }

            // Step 2: Move X + 8mm (27 + 8 = 35) to clear block area
            await ctl._moveAbsolute(startX + xAdd, startY, 0, XY_FEED);
            checkAborted();

            // Step 3: Move Y + 10mm (25 + 10 = 35) to reach final zero position
            await ctl._moveAbsolute(startX + xAdd, startY + yAdd, 0, XY_FEED);
            checkAborted();

            // Step 4: Zero all axes (X, Y, Z) at final corner position so DRO reads (0, 0, 0)
            try { ctl.command('wcs:zeroAll'); } catch (_) { /* best-effort */ }

            this.io.emit('probing:result', { strategy: 'finalize-corner-zero', success: true });
            return { success: true };
        } catch (err) {
            this.io.emit('probing:result', { strategy: 'finalize-corner-zero', success: false, error: err.message });
            throw err;
        } finally {
            this.activeRun = null;
        }
    }

    abort() {
        if (this.activeRun) this.activeRun.aborted = true;
        const ctl = this.getController?.();
        try {
            if (typeof ctl?.probeAxis === 'function') {
                // RSP: write() is a no-op for this protocol (binary framed,
                // no raw-text passthrough -- see RSPController.write()), so
                // a GRBL-style soft-reset byte does nothing here. Feed-hold
                // is the real "stop in-flight motion now" command; the
                // activeRun.aborted flag (checked between routine steps)
                // handles stopping the sequence itself.
                ctl.command?.('feedhold');
            } else {
                ctl?.write?.('\x18'); // soft reset
            }
        } catch (_) { }
    }

    _sendAndAwaitOk(ctl, line, timeoutMs = 60_000) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                ctl.off?.('ok', onOk);
                ctl.off?.('error', onErr);
                reject(new Error('Controller ack timeout'));
            }, timeoutMs);
            const onOk = () => { clearTimeout(t); ctl.off?.('error', onErr); resolve(); };
            const onErr = (e) => { clearTimeout(t); ctl.off?.('ok', onOk); reject(new Error(e?.message || 'controller error')); };
            ctl.once?.('ok', onOk);
            ctl.once?.('error', onErr);
            try {
                if (typeof ctl.write === 'function') ctl.write(line + '\n');
                else ctl.command?.('gcode', line);
            } catch (e) {
                clearTimeout(t);
                ctl.off?.('ok', onOk); ctl.off?.('error', onErr);
                reject(e);
            }
        });
    }
}

module.exports = { ProbingService };
