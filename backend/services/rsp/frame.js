/**
 * RSP -- Reliable Stream Protocol frame layer.
 *
 * Faithful JS port of the Python reference (backend/rsp/frame.py from
 * fw_m3_control_sw). Wire format (little-endian, after byte-stuffing):
 *
 *   [0x7E START][TYPE 1B][FLAGS 1B][SEQ 2B][LEN 2B][PAYLOAD <= 240B][CRC32 4B][0x5A END]
 *
 * Body = TYPE..CRC (6 + LEN + 4 bytes). Byte-stuffing: within the body,
 * 0x7E / 0x5A / 0x7D are emitted as 0x7D (byte ^ 0x01). The parser is a
 * simple resynchronizing state machine: it looks for START, un-escapes the
 * body, validates length, and CRC-checks the complete frame.
 *
 * MUST stay byte-for-byte identical to frame.py -- see
 * scratch/rsp_build/crc_compare.* for the cross-language verification test.
 */
'use strict';

const START = 0x7E;
const END = 0x5A;
const ESC = 0x7D;

const MAX_PAYLOAD = 240;
const HEADER_LEN = 6; // type + flags + seq(2) + len(2)

// frame types
const FT_CMD = 0x01;
const FT_RSP = 0x02;
const FT_EVT = 0x03;
const FT_ACK = 0x04;
const FT_NAK = 0x05;
const FT_HB = 0x06;

// flags
const F_ACK = 0x01; // sender requires an ACK
const F_LAST = 0x02; // last item of a job / session

class ProtocolError extends Error {}

// --------------------------------------------------------------------------
// CRC32 (IEEE 802.3, reflected) -- identical table/algorithm to frame.py
// --------------------------------------------------------------------------
const _CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _CRC_TABLE[i] = c >>> 0;
}

/**
 * @param {Buffer} data
 * @returns {number} unsigned 32-bit CRC
 */
function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = (_CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// --------------------------------------------------------------------------
// frame construction
// --------------------------------------------------------------------------
/**
 * @param {number} frameType
 * @param {number} flags
 * @param {number} seq
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function buildFrame(frameType, flags, seq, payload) {
    if (!Buffer.isBuffer(payload)) {
        payload = Buffer.from(payload || []);
    }
    if (payload.length > MAX_PAYLOAD) {
        throw new ProtocolError(`payload too long: ${payload.length} > ${MAX_PAYLOAD}`);
    }
    const body = Buffer.alloc(HEADER_LEN + payload.length + 4);
    body.writeUInt8(frameType & 0xFF, 0);
    body.writeUInt8(flags & 0xFF, 1);
    body.writeUInt16LE(seq & 0xFFFF, 2);
    body.writeUInt16LE(payload.length, 4);
    payload.copy(body, HEADER_LEN);
    const crc = crc32(body.subarray(0, HEADER_LEN + payload.length));
    body.writeUInt32LE(crc >>> 0, HEADER_LEN + payload.length);

    const out = [];
    out.push(START);
    for (let i = 0; i < body.length; i++) {
        const b = body[i];
        if (b === START || b === END || b === ESC) {
            out.push(ESC);
            out.push((b ^ 0x01) & 0xFF);
        } else {
            out.push(b);
        }
    }
    out.push(END);
    return Buffer.from(out);
}

class ParsedFrame {
    constructor(frameType, flags, seq, payload) {
        this.frameType = frameType;
        this.flags = flags;
        this.seq = seq;
        this.payload = payload; // Buffer
    }

    toString() {
        return `<Frame type=0x${this.frameType.toString(16).padStart(2, '0')} ` +
            `flags=0x${this.flags.toString(16).padStart(2, '0')} seq=${this.seq} ` +
            `pl=${this.payload.length}>`;
    }
}

const _WAIT_START = 0;
const _BODY = 1;
const _WAIT_END = 2;

/** Incremental, resynchronizing RSP frame parser. */
class FrameParser {
    constructor() {
        this._reset();
    }

    _reset() {
        this._state = _WAIT_START;
        this._body = [];
        this._bodyLen = -1;
        this._escaped = false;
    }

    _resetFrom(b) {
        this._reset();
        if (b === START) {
            this._state = _BODY;
        }
    }

    /**
     * @param {Buffer} data
     * @returns {ParsedFrame[]}
     */
    feed(data) {
        const frames = [];
        for (let i = 0; i < data.length; i++) {
            this._byte(data[i], frames);
        }
        return frames;
    }

    _byte(b, frames) {
        if (this._state === _WAIT_START) {
            if (b === START) {
                this._state = _BODY;
            }
            return;
        }

        if (this._state === _BODY) {
            if (this._escaped) {
                this._body.push((b ^ 0x01) & 0xFF);
                this._escaped = false;
            } else if (b === ESC) {
                this._escaped = true;
            } else {
                this._body.push(b);
            }

            if (this._body.length >= HEADER_LEN && this._bodyLen < 0) {
                const plen = this._body[4] | (this._body[5] << 8);
                if (plen > MAX_PAYLOAD) {
                    this._resetFrom(b);
                    return;
                }
                this._bodyLen = HEADER_LEN + plen + 4;
                if (this._bodyLen > MAX_PAYLOAD + HEADER_LEN + 4) {
                    this._resetFrom(b);
                    return;
                }
            }

            if (this._bodyLen > 0 && this._body.length >= this._bodyLen) {
                this._state = _WAIT_END;
            }
            return;
        }

        if (this._state === _WAIT_END) {
            if (b === END) {
                const f = this._tryEmit();
                if (f !== null) {
                    frames.push(f);
                }
            }
            this._resetFrom(b);
            return;
        }
    }

    _tryEmit() {
        if (this._bodyLen <= 0) {
            return null;
        }
        const body = Buffer.from(this._body);
        const frameType = body.readUInt8(0);
        const flags = body.readUInt8(1);
        const seq = body.readUInt16LE(2);
        const plen = body.readUInt16LE(4);
        const expected = HEADER_LEN + plen + 4;
        if (body.length !== expected) {
            return null;
        }
        const stored = body.readUInt32LE(HEADER_LEN + plen);
        if (stored !== crc32(body.subarray(0, HEADER_LEN + plen))) {
            return null;
        }
        return new ParsedFrame(frameType, flags, seq, body.subarray(HEADER_LEN, HEADER_LEN + plen));
    }
}

module.exports = {
    START, END, ESC,
    MAX_PAYLOAD, HEADER_LEN,
    FT_CMD, FT_RSP, FT_EVT, FT_ACK, FT_NAK, FT_HB,
    F_ACK, F_LAST,
    ProtocolError,
    crc32,
    buildFrame,
    ParsedFrame,
    FrameParser,
};
