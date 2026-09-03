/**
 * RSP command/status/event definitions (wire constants shared host+device).
 *
 * Faithful JS port of the Python reference (backend/rsp/defs.py from
 * fw_m3_control_sw). MUST stay byte-for-byte identical in struct layout --
 * see pack_telemetry/Telemetry below (fixed 46-byte block).
 */
'use strict';

// ---------------------------------------------------------------------------
// Host -> device command opcodes (payload[0])
// ---------------------------------------------------------------------------
const OP_GET_STATUS = 0x01;      // request telemetry reply
const OP_PING = 0x02;            // payload[1] nonce byte; reply echoes it
const OP_GET_RUN_STATE = 0x03;   // reply: job_id, last executed line, position, state
const OP_GET_CONFIG = 0x04;      // reply: machine config JSON (from device)
const OP_SOFT_RESET = 0x05;
const OP_UNLOCK = 0x06;
const OP_E_STOP = 0x07;
const OP_FEED_HOLD = 0x08;
const OP_RESUME = 0x09;
const OP_JOG = 0x0A;             // payload: axis u8 dir u8 dist f32 feed f32
const OP_HOME = 0x0B;            // payload: axis_mask u8
const OP_ZERO = 0x0C;            // payload: axis_mask u8
const OP_JOB_START = 0x0D;       // payload: job_id u16 total_lines u16
const OP_JOB_LINE = 0x0E;        // payload: job_id u16 line_no u16 gcode(ascii, null-term)
const OP_JOB_END = 0x0F;         // payload: job_id u16
const OP_JOB_ABORT = 0x10;       // payload: job_id u16
const OP_SET_FEED_OVERRIDE = 0x11; // payload: percent f32 (50.0..150.0)
const OP_MOVE = 0x12;            // absolute move: x f32 y f32 z f32 feed f32 (16B)
const OP_PROBE = 0x13;           // payload: axis u8 (0=X,1=Y,2=Z) dir u8 (1=neg)
                                  // max_travel_mm f32 feed f32 -- same 10-byte
                                  // shape as OP_JOG. Reply on ST_OK (18B):
                                  // result u8 (0=contact,1=no_contact -- a miss
                                  // is NOT an error status) axis u8 dist_mm f32
                                  // x f32 y f32 z f32 (resulting machine position)

// Reverse lookup for diagnostic logging.
const OP_NAMES = {};
{
    const ops = {
        OP_GET_STATUS, OP_PING, OP_GET_RUN_STATE, OP_GET_CONFIG, OP_SOFT_RESET,
        OP_UNLOCK, OP_E_STOP, OP_FEED_HOLD, OP_RESUME, OP_JOG, OP_HOME, OP_ZERO,
        OP_JOB_START, OP_JOB_LINE, OP_JOB_END, OP_JOB_ABORT, OP_SET_FEED_OVERRIDE,
        OP_MOVE, OP_PROBE,
    };
    for (const [name, val] of Object.entries(ops)) {
        OP_NAMES[val] = name;
    }
}

// ---------------------------------------------------------------------------
// Device -> host status codes (in RSP payload[1])
// ---------------------------------------------------------------------------
const ST_OK = 0x00;
const ST_ERR_INTERNAL = 0x01;
const ST_ERR_BUSY = 0x02;          // device busy, try again
const ST_ERR_STATE = 0x03;         // not allowed in current machine state
const ST_ERR_JOB = 0x04;           // job_id mismatch / no active job
const ST_ERR_SEQ_GAP = 0x05;       // out-of-window sequence (host must resend from gap)
const ST_ERR_CRC = 0x06;           // frame CRC failed
const ST_ERR_BUFFER = 0x07;        // device planner full (flow control)
const ST_ERR_CMD = 0x08;           // unknown command / bad payload
const ST_ERR_ESTOP = 0x09;         // e-stop latched, cannot execute
const ST_ERR_FAULT = 0x0A;         // axis fault

// Reverse lookup for diagnostic logging, same pattern as OP_NAMES above.
// NOTE: named ST_ERR_NAMES (not ST_NAMES) and built here -- BEFORE the
// ST_BOOT.. machine-state block below -- so it only captures ST_OK/ST_ERR_*
// and can never collide with STATE_NAMES (machine states, same "ST_" prefix,
// overlapping small integers e.g. ST_ERR_STATE==0x03==ST_JOGGING).
const ST_ERR_NAMES = {};
{
    const sts = {
        ST_OK, ST_ERR_INTERNAL, ST_ERR_BUSY, ST_ERR_STATE, ST_ERR_JOB,
        ST_ERR_SEQ_GAP, ST_ERR_CRC, ST_ERR_BUFFER, ST_ERR_CMD, ST_ERR_ESTOP,
        ST_ERR_FAULT,
    };
    for (const [name, val] of Object.entries(sts)) {
        ST_ERR_NAMES[val] = name;
    }
}

// ---------------------------------------------------------------------------
// Probe result codes (OP_PROBE reply payload[0], only ever 0/1 -- ESTOP/FAULT
// aborts come back as a normal ST_ERR_ESTOP/ST_ERR_FAULT status instead, see
// rsp_handle_probe() in easycnc_protocol.c)
// ---------------------------------------------------------------------------
const PROBE_RESULT_CONTACT = 0;
const PROBE_RESULT_NO_CONTACT = 1;

// ---------------------------------------------------------------------------
// Device -> host event opcodes (EVT payload[0])
// ---------------------------------------------------------------------------
const EV_EXECUTED = 0x01;        // payload: job_id u16 line_no u16 x f32 y f32 z f32
const EV_JOB_DONE = 0x02;        // payload: job_id u16
const EV_FAULT = 0x03;           // payload: axis u8 code u8
const EV_ESTOP = 0x04;           // payload: none
const EV_COMM_LOST = 0x05;       // payload: none (device entered safe-stop state)
const EV_STATUS = 0x06;          // payload: telemetry block (see Telemetry)

// ---------------------------------------------------------------------------
// Machine states (same ordinals as firmware sys_state_t -- MUST match)
// ---------------------------------------------------------------------------
const ST_BOOT = 0;
const ST_IDLE = 1;
const ST_HOMING = 2;
const ST_JOGGING = 3;
const ST_STREAMING = 4;
const ST_RUNNING = 5;
const ST_HOLD = 6;
const ST_STOPPING = 7;
const ST_ALARM = 8;
const ST_ESTOP = 9;
const ST_FAULT = 10;

const STATE_NAMES = {
    [ST_BOOT]: 'Boot',
    [ST_IDLE]: 'Idle',
    [ST_HOMING]: 'Homing',
    [ST_JOGGING]: 'Jog',
    [ST_STREAMING]: 'Stream',
    [ST_RUNNING]: 'Run',
    [ST_HOLD]: 'Hold',
    [ST_STOPPING]: 'Stop',
    [ST_ALARM]: 'Alarm',
    [ST_ESTOP]: 'EStop',
    [ST_FAULT]: 'Fault',
};

// ---------------------------------------------------------------------------
// Telemetry block layout (fixed 46 bytes) -- EV_STATUS / GET_STATUS reply
//
// DEBUG (2026-08-28, job-63998 stall investigation, remove once root-caused):
// the last 5 fields (jog_active, jog_done_evt, tim2_isr_count, steps_done,
// steps_total) are a temporary extension exposing fw_m3/Src/stepper.c's
// async DDA engine internals -- see jogeng_debug_get() on the firmware side.
// Must stay in lockstep with rsp_defs.h's RSP_TEL_LEN/rsp_build_telemetry().
//
// Struct format (Python): "<BBBBfffffHHBBBBBBIII"
//   B state, B fault_flags, B limit_flags, B flags            (4 bytes,  @0)
//   f x, f y, f z, f feed, f spindle_speed                    (20 bytes, @4)
//   H last_executed_line, H job_id                            (4 bytes,  @24)
//   B buffer_fill_pct, B planner_depth, B link_ok, B error_code (4 bytes, @28)
//   B jog_active, B jog_done_evt                               (2 bytes, @32)
//   I tim2_isr_count, I steps_done, I steps_total              (12 bytes, @34)
//   = 46 bytes total
// ---------------------------------------------------------------------------
const TEL_LEN = 46;

/**
 * @param {object} f fields (see Telemetry ctor param names)
 * @returns {Buffer} 46-byte little-endian telemetry block
 */
function packTelemetry(f) {
    const buf = Buffer.alloc(TEL_LEN);
    let o = 0;
    buf.writeUInt8(f.state & 0xFF, o); o += 1;
    buf.writeUInt8(f.faultFlags & 0xFF, o); o += 1;
    buf.writeUInt8(f.limitFlags & 0xFF, o); o += 1;
    buf.writeUInt8(f.flags & 0xFF, o); o += 1;
    buf.writeFloatLE(f.x, o); o += 4;
    buf.writeFloatLE(f.y, o); o += 4;
    buf.writeFloatLE(f.z, o); o += 4;
    buf.writeFloatLE(f.feed, o); o += 4;
    buf.writeFloatLE(f.spindleSpeed, o); o += 4;
    buf.writeUInt16LE(f.lastExecutedLine & 0xFFFF, o); o += 2;
    buf.writeUInt16LE(f.jobId & 0xFFFF, o); o += 2;
    buf.writeUInt8(f.bufferFillPct & 0xFF, o); o += 1;
    buf.writeUInt8(f.plannerDepth & 0xFF, o); o += 1;
    buf.writeUInt8(f.linkOk & 0xFF, o); o += 1;
    buf.writeUInt8(f.errorCode & 0xFF, o); o += 1;
    buf.writeUInt8(f.jogActive & 0xFF, o); o += 1;
    buf.writeUInt8(f.jogDoneEvt & 0xFF, o); o += 1;
    buf.writeUInt32LE(f.tim2IsrCount >>> 0, o); o += 4;
    buf.writeUInt32LE(f.stepsDone >>> 0, o); o += 4;
    buf.writeUInt32LE(f.stepsTotal >>> 0, o); o += 4;
    return buf;
}

class Telemetry {
    /**
     * @param {Buffer} data exactly TEL_LEN bytes
     */
    constructor(data) {
        if (!Buffer.isBuffer(data) || data.length !== TEL_LEN) {
            throw new Error(`Telemetry: expected ${TEL_LEN} bytes, got ${data ? data.length : 'null'}`);
        }
        let o = 0;
        this.state = data.readUInt8(o); o += 1;
        this.faultFlags = data.readUInt8(o); o += 1;
        this.limitFlags = data.readUInt8(o); o += 1;
        this.flags = data.readUInt8(o); o += 1;
        this.x = data.readFloatLE(o); o += 4;
        this.y = data.readFloatLE(o); o += 4;
        this.z = data.readFloatLE(o); o += 4;
        this.feed = data.readFloatLE(o); o += 4;
        this.spindleSpeed = data.readFloatLE(o); o += 4;
        this.lastExecutedLine = data.readUInt16LE(o); o += 2;
        this.jobId = data.readUInt16LE(o); o += 2;
        this.bufferFillPct = data.readUInt8(o); o += 1;
        this.plannerDepth = data.readUInt8(o); o += 1;
        this.linkOk = data.readUInt8(o); o += 1;
        this.errorCode = data.readUInt8(o); o += 1;
        this.jogActive = data.readUInt8(o); o += 1;
        this.jogDoneEvt = data.readUInt8(o); o += 1;
        this.tim2IsrCount = data.readUInt32LE(o); o += 4;
        this.stepsDone = data.readUInt32LE(o); o += 4;
        this.stepsTotal = data.readUInt32LE(o); o += 4;
    }

    powered() {
        return !!(this.flags & 0x01);
    }

    estopActive() {
        return !!(this.flags & 0x02);
    }

    commLost() {
        return !!(this.flags & 0x04);
    }

    jobActive() {
        return !!(this.flags & 0x08);
    }

    feedHold() {
        return !!(this.flags & 0x10);
    }

    stateName() {
        return STATE_NAMES[this.state] || `State${this.state}`;
    }

    asDict() {
        return {
            state: this.state,
            state_name: this.stateName(),
            fault_flags: this.faultFlags,
            limit_flags: this.limitFlags,
            flags: this.flags,
            x: this.x, y: this.y, z: this.z,
            feed: this.feed,
            spindle_speed: this.spindleSpeed,
            last_executed_line: this.lastExecutedLine,
            job_id: this.jobId,
            buffer_fill_pct: this.bufferFillPct,
            planner_depth: this.plannerDepth,
            link_ok: this.linkOk,
            error_code: this.errorCode,
            powered: this.powered(),
            estop_active: this.estopActive(),
            comm_lost: this.commLost(),
            job_active: this.jobActive(),
            feed_hold: this.feedHold(),
            dbg_jog_active: this.jogActive,
            dbg_jog_done_evt: this.jogDoneEvt,
            dbg_tim2_isr_count: this.tim2IsrCount,
            dbg_steps_done: this.stepsDone,
            dbg_steps_total: this.stepsTotal,
        };
    }
}

module.exports = {
    OP_GET_STATUS, OP_PING, OP_GET_RUN_STATE, OP_GET_CONFIG, OP_SOFT_RESET,
    OP_UNLOCK, OP_E_STOP, OP_FEED_HOLD, OP_RESUME, OP_JOG, OP_HOME, OP_ZERO,
    OP_JOB_START, OP_JOB_LINE, OP_JOB_END, OP_JOB_ABORT, OP_SET_FEED_OVERRIDE,
    OP_MOVE, OP_PROBE, OP_NAMES,
    ST_OK, ST_ERR_INTERNAL, ST_ERR_BUSY, ST_ERR_STATE, ST_ERR_JOB,
    ST_ERR_SEQ_GAP, ST_ERR_CRC, ST_ERR_BUFFER, ST_ERR_CMD, ST_ERR_ESTOP,
    ST_ERR_FAULT, ST_ERR_NAMES,
    PROBE_RESULT_CONTACT, PROBE_RESULT_NO_CONTACT,
    EV_EXECUTED, EV_JOB_DONE, EV_FAULT, EV_ESTOP, EV_COMM_LOST, EV_STATUS,
    ST_BOOT, ST_IDLE, ST_HOMING, ST_JOGGING, ST_STREAMING, ST_RUNNING,
    ST_HOLD, ST_STOPPING, ST_ALARM, ST_ESTOP, ST_FAULT, STATE_NAMES,
    TEL_LEN,
    packTelemetry,
    Telemetry,
};
