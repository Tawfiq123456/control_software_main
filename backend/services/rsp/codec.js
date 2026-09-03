/**
 * RSP payload codec: build command payloads, parse reply/event payloads.
 *
 * Faithful JS port of the Python reference (backend/rsp/codec.py from
 * fw_m3_control_sw).
 */
'use strict';

// Firmware's rsp_handle_job_line() (easycnc_protocol.c) uses a fixed
// `char text[64]` buffer and silently truncates -- no NAK/error -- past 63
// usable bytes. The host must enforce the same cap or a long G-code line
// (e.g. an arc with many params) will silently execute truncated/wrong on
// the real board even though it fits the 240-byte frame payload limit.
const MAX_GCODE_LEN = 63;

function buildJog(axis, direction, distMm, feed) {
    const buf = Buffer.alloc(10);
    buf.writeUInt8(axis & 0xFF, 0);
    buf.writeUInt8(direction & 0xFF, 1);
    buf.writeFloatLE(distMm, 2);
    buf.writeFloatLE(feed, 6);
    return buf;
}

function buildHome(axisMask) {
    return Buffer.from([axisMask & 0xFF]);
}

function buildZero(axisMask) {
    return Buffer.from([axisMask & 0xFF]);
}

function buildJobStart(jobId, totalLines) {
    const buf = Buffer.alloc(4);
    buf.writeUInt16LE(jobId & 0xFFFF, 0);
    buf.writeUInt16LE(totalLines & 0xFFFF, 2);
    return buf;
}

function buildJobLine(jobId, lineNo, gcode) {
    if (gcode.indexOf('\x00') !== -1) {
        throw new Error('gcode line must not contain NUL');
    }
    let g = Buffer.from(gcode, 'utf-8');
    if (g.length > MAX_GCODE_LEN) {
        // eslint-disable-next-line no-console
        console.warn(
            `job line ${lineNo} is ${g.length} bytes, truncating to firmware's ` +
            `${MAX_GCODE_LEN}-byte buffer limit: ${JSON.stringify(gcode)}`
        );
        g = g.subarray(0, MAX_GCODE_LEN);
    }
    const head = Buffer.alloc(4);
    head.writeUInt16LE(jobId & 0xFFFF, 0);
    head.writeUInt16LE(lineNo & 0xFFFF, 2);
    return Buffer.concat([head, g]);
}

function buildJobEnd(jobId) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(jobId & 0xFFFF, 0);
    return buf;
}

function buildJobAbort(jobId) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(jobId & 0xFFFF, 0);
    return buf;
}

function buildFeedOverride(percent) {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(percent, 0);
    return buf;
}

function buildMove(x, y, z, feed) {
    const buf = Buffer.alloc(16);
    buf.writeFloatLE(x, 0);
    buf.writeFloatLE(y, 4);
    buf.writeFloatLE(z, 8);
    buf.writeFloatLE(feed, 12);
    return buf;
}

function parseMove(payload) {
    return {
        x: payload.readFloatLE(0),
        y: payload.readFloatLE(4),
        z: payload.readFloatLE(8),
        feed: payload.readFloatLE(12),
    };
}

// axis u8 (0=X,1=Y,2=Z) dir u8 (1=neg) max_travel_mm f32 feed f32 --
// same 10-byte shape as buildJog.
function buildProbe(axis, dir, maxTravelMm, feed) {
    const buf = Buffer.alloc(10);
    buf.writeUInt8(axis & 0xFF, 0);
    buf.writeUInt8(dir & 0xFF, 1);
    buf.writeFloatLE(maxTravelMm, 2);
    buf.writeFloatLE(feed, 6);
    return buf;
}

// --------------------------------------------------------------------------
// reply parsers
// --------------------------------------------------------------------------
function parseJog(payload) {
    return {
        axis: payload.readUInt8(0),
        direction: payload.readUInt8(1),
        dist: payload.readFloatLE(2),
        feed: payload.readFloatLE(6),
    };
}

function parseHomeZero(payload) {
    return payload[0];
}

function parseJobStart(payload) {
    return {
        jobId: payload.readUInt16LE(0),
        total: payload.readUInt16LE(2),
    };
}

function parseJobLine(payload) {
    const jobId = payload.readUInt16LE(0);
    const lineNo = payload.readUInt16LE(2);
    const rest = payload.subarray(4);
    const nul = rest.indexOf(0x00);
    const gcodeBuf = nul === -1 ? rest : rest.subarray(0, nul);
    const gcode = gcodeBuf.toString('utf-8');
    return { jobId, lineNo, gcode };
}

function parseJobEnd(payload) {
    return payload.readUInt16LE(0);
}

function parseFeedOverride(payload) {
    return payload.readFloatLE(0);
}

function parseEvExecuted(payload) {
    return {
        jobId: payload.readUInt16LE(0),
        lineNo: payload.readUInt16LE(2),
        x: payload.readFloatLE(4),
        y: payload.readFloatLE(8),
        z: payload.readFloatLE(12),
    };
}

function parseEvJobDone(payload) {
    return payload.readUInt16LE(0);
}

function parseEvFault(payload) {
    return {
        axis: payload.readUInt8(0),
        code: payload.readUInt8(1),
    };
}

// result u8 (0=contact,1=no_contact) axis u8 dist_mm f32 x f32 y f32 z f32 --
// 18 bytes, on RSP_ST_OK only (ESTOP/FAULT aborts come back as a normal
// error status instead, see rsp_handle_probe() in easycnc_protocol.c).
function parseProbeResult(payload) {
    return {
        result: payload.readUInt8(0),
        axis: payload.readUInt8(1),
        distMm: payload.readFloatLE(2),
        x: payload.readFloatLE(6),
        y: payload.readFloatLE(10),
        z: payload.readFloatLE(14),
    };
}

module.exports = {
    MAX_GCODE_LEN,
    buildJog, buildHome, buildZero, buildJobStart, buildJobLine, buildJobEnd,
    buildJobAbort, buildFeedOverride, buildMove, parseMove, buildProbe,
    parseJog, parseHomeZero, parseJobStart, parseJobLine, parseJobEnd,
    parseFeedOverride, parseEvExecuted, parseEvJobDone, parseEvFault,
    parseProbeResult,
};
