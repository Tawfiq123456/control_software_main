/**
 * RecoveryOrchestrator — builds the G-code preamble needed to restore
 * machine modal state before resuming a job from a checkpoint.
 *
 * After a power loss or pause, the machine's modal state (units, distance
 * mode, feed rate, spindle, coolant, WCS) may have been lost or reset to
 * defaults. The G-code lines from the resume point forward assume whatever
 * modal state was in effect when the job was running — if we don't restore
 * it first, the first cut line could execute in the wrong units (inches vs
 * mm), wrong distance mode (absolute vs incremental), with no spindle, etc.
 *
 * This module is stateless — it takes a checkpoint record and current
 * machine position, and returns the G-code lines to inject before the
 * first real cut line of the resumed job.
 *
 * The preamble order is important:
 *   1. Units (affects interpretation of all subsequent numeric values)
 *   2. Feed mode
 *   3. Switch to absolute mode (needed for the safe-Z/XY repositioning)
 *   4. Raise to safe Z
 *   5. Move to XY of last confirmed position
 *   6. Restore feed rate
 *   7. Restore spindle
 *   8. Restore coolant
 *   9. Lower to Z of last confirmed position
 *  10. Restore the original distance mode (may differ from G90)
 */
'use strict';

class RecoveryOrchestrator {
    /**
     * Builds a preamble of G-code lines that restore the machine to the
     * modal state captured in the checkpoint, so the first real cut line
     * executes in the correct context.
     *
     * @param {object} checkpoint - The loaded checkpoint record (schema v2)
     * @param {object} [currentPos] - Current machine position {x,y,z} from telemetry
     * @param {number} [safeZ=10] - Safe Z clearance height in current units
     * @returns {string[]} G-code lines to inject before resume
     */
    static buildResumePreamble(checkpoint, currentPos, safeZ = 10) {
        const lines = [];
        const modal = checkpoint.modalState || {};
        const pos = checkpoint.lastConfirmedPos || {};

        // ── 1. Set units first (affects all subsequent coordinates) ──
        const units = modal.units || 'G21';
        lines.push(units);

        // ── 2. Set feed mode ──
        if (modal.feedMode && modal.feedMode !== 'G94') {
            lines.push(modal.feedMode);
        }

        // ── 3. Switch to absolute mode for repositioning moves ──
        // We need absolute mode for the safe-Z raise and XY move regardless
        // of what the job was using. We'll restore the original mode at the end.
        lines.push('G90');

        // ── 4. Raise to safe Z ──
        // This ensures the tool clears any obstacles/workpiece before moving XY.
        lines.push(`G0 Z${_fmt(safeZ)}`);

        // ── 5. Move to XY of last confirmed position ──
        if (pos.x != null && pos.y != null) {
            lines.push(`G0 X${_fmt(pos.x)} Y${_fmt(pos.y)}`);
        }

        // ── 6. Restore feed rate ──
        // Set this before spindle start so any feed-dependent modes are ready.
        if (modal.feedRate && modal.feedRate > 0) {
            lines.push(`F${_fmt(modal.feedRate)}`);
        }

        // ── 7. Restore spindle ──
        if (modal.spindleState === 'M3' || modal.spindleState === 'M4') {
            const rpm = modal.spindleRpm || 0;
            lines.push(`${modal.spindleState} S${_fmt(rpm)}`);
            // Give the spindle time to reach speed — a short dwell.
            // Real spindles need 2-5 seconds to reach RPM. G4 P2 = 2 second dwell.
            if (rpm > 0) {
                lines.push('G4 P2');
            }
        }

        // ── 8. Restore coolant ──
        if (modal.coolantState && modal.coolantState !== 'M9') {
            lines.push(modal.coolantState);
        }

        // ── 9. Lower to Z of last confirmed position ──
        // After XY repositioning, drop Z to where the cut was happening.
        if (pos.z != null) {
            lines.push(`G1 Z${_fmt(pos.z)} F${_fmt(modal.feedRate || 500)}`);
        }

        // ── 10. Restore the original distance mode ──
        // If the job was in incremental mode (G91), restore it now that all
        // absolute-mode repositioning moves are done.
        const distMode = modal.distanceMode || 'G90';
        if (distMode !== 'G90') {
            lines.push(distMode);
        }

        // ── 11. Restore WCS if not default ──
        const wcs = modal.wcs || 'G54';
        if (wcs !== 'G54') {
            lines.push(wcs);
        }

        return lines;
    }

    /**
     * Validate a checkpoint record for resume eligibility.
     *
     * @param {object} checkpoint
     * @returns {{ valid: boolean, reason?: string }}
     */
    static validateCheckpoint(checkpoint) {
        if (!checkpoint) {
            return { valid: false, reason: 'No checkpoint data' };
        }
        if (!checkpoint.gcodeText || !checkpoint.gcodeText.trim()) {
            return { valid: false, reason: 'Checkpoint has no G-code text' };
        }
        if (!checkpoint.gcodeHash) {
            return { valid: false, reason: 'Checkpoint has no integrity hash' };
        }
        if (typeof checkpoint.lastExecutedLine !== 'number' || checkpoint.lastExecutedLine < 0) {
            return { valid: false, reason: 'Invalid lastExecutedLine' };
        }
        if (typeof checkpoint.totalLines !== 'number' || checkpoint.totalLines <= 0) {
            return { valid: false, reason: 'Invalid totalLines' };
        }
        if (checkpoint.lastExecutedLine >= checkpoint.totalLines) {
            return { valid: false, reason: 'Job already completed (lastExecutedLine >= totalLines)' };
        }
        return { valid: true };
    }

    /**
     * Compute the correct resume line number from a checkpoint.
     *
     * The resume line is the first line that was NOT confirmed executed.
     * If planner state is available, it uses the earliest unconfirmed line
     * rather than lastExecuted + 1 (some lines may have been ACK'd into
     * the planner but not yet executed).
     *
     * @param {object} checkpoint
     * @param {object} [plannerState] - { firstUnconfirmed }
     * @returns {number} 1-based line number to resume from
     */
    static computeResumeLine(checkpoint, plannerState) {
        const lastExecuted = checkpoint.lastExecutedLine || 0;

        // If planner state is available, use the earliest unconfirmed line.
        // This accounts for lines that were ACK'd (accepted into planner)
        // but never confirmed as executed — they may need to be re-sent.
        if (plannerState && typeof plannerState.firstUnconfirmed === 'number') {
            // The first unconfirmed line is the one the device may or may not
            // have actually executed, so we resume from there.
            return Math.max(1, Math.min(plannerState.firstUnconfirmed, lastExecuted + 1));
        }

        // Default: resume from the line after the last confirmed one.
        return Math.max(1, lastExecuted + 1);
    }
}

/**
 * Format a number for G-code: up to 4 decimal places, no trailing zeros.
 * @param {number} n
 * @returns {string}
 */
function _fmt(n) {
    if (n == null || isNaN(n)) return '0';
    // toFixed(4) then strip trailing zeros, but keep at least one digit
    // after the decimal if the number is not an integer.
    const s = Number(n).toFixed(4);
    // Remove trailing zeros after decimal point
    return s.replace(/\.?0+$/, '') || '0';
}

module.exports = { RecoveryOrchestrator };
