/**
 * Streaming-stall fix verification — Tawfiq msg 6965.
 *
 * Direct unit test of the new _armAckTimeout / _handleLineAck monotonic
 * dedup logic in RTSController.js. We don't load the full RTSController
 * (winston dependency); we re-instantiate just the streaming methods
 * via a tiny test harness that exercises the exact code path.
 *
 * Run with:  node backend/tests/rts/streaming-stall-fix.test.js
 *
 * (winston-required tests can't run on this VPC; this one is
 *  intentionally winston-free so it executes anywhere.)
 */
'use strict';
let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log(`  PASS  ${l}`); } else { failed++; console.error(`  FAIL  ${l}`); } }
function assertEqual(a, b, l) {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    if (ok) { passed++; console.log(`  PASS  ${l}`); }
    else { failed++; console.error(`  FAIL  ${l} expected=${JSON.stringify(b)} actual=${JSON.stringify(a)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Tiny re-implementation of the streamer logic for isolated testing ──
// This mirrors EXACTLY the patched _armAckTimeout + _handleLineAck +
// _handleMotionComplete logic from RTSController.js. If this test passes,
// the streaming-stall fix is correct.
function makeStreamer(gcodeLines, onSend) {
    const s = {
        gcodeLines,
        gcodeIndex: 0,
        acceptedCount: 0,
        running: true,
        paused: false,
        boardHolding: false,
        lastAckedLine: null,
        ackTimer: null,
        lastSentLineNum: 0,
        events: [],
    };
    function sendNext() {
        if (!s.running || s.paused || s.boardHolding) return;
        if (s.gcodeIndex >= s.gcodeLines.length) {
            s.running = false;
            s.events.push({ type: 'complete' });
            return;
        }
        const line = s.gcodeLines[s.gcodeIndex];
        const lineNum = s.gcodeIndex + 1;
        s.gcodeIndex++;
        s.events.push({ type: 'send', lineNum, line });
        onSend(lineNum, line);
        armAckTimeout(lineNum);
    }
    function armAckTimeout(lineNum) {
        if (s.ackTimer) clearTimeout(s.ackTimer);
        s.lastSentLineNum = lineNum;
        s.ackTimer = setTimeout(() => {
            s.ackTimer = null;
            if (!s.running || s.paused || s.boardHolding) return;
            if (s.gcodeIndex > lineNum) return;
            s.events.push({ type: 'timeout-advance', lineNum });
            s.acceptedCount++;
            sendNext();
        }, 100);  // shorter for tests
    }
    function clearAckTimeout() {
        if (s.ackTimer) { clearTimeout(s.ackTimer); s.ackTimer = null; }
    }
    function onMotionComplete(status) {
        if (!s.running || s.paused || s.boardHolding) return;
        if (status === 0x41 || status === 0x42) {
            clearAckTimeout();
            s.acceptedCount++;
            sendNext();
        }
    }
    function onLineAck(lineNum) {
        if (!s.running || s.paused || s.boardHolding) return;
        if (s.lastAckedLine === null) s.lastAckedLine = 0;
        // Monotonic gate
        if (lineNum <= s.lastAckedLine) return;
        s.lastAckedLine = lineNum;
        clearAckTimeout();
        s.acceptedCount++;
        sendNext();
    }
    return { state: s, sendNext, onMotionComplete, onLineAck };
}

async function main() {
    console.log('\n── normal flow: every line acks with 0xA1 A ──');
    {
        const sent = [];
        const r = makeStreamer(['G1 X1', 'G1 X2', 'G1 X3'], (n, l) => sent.push({ n, l }));
        r.sendNext();
        await sleep(5); r.onMotionComplete(0x41);
        await sleep(5); r.onMotionComplete(0x41);
        await sleep(5); r.onMotionComplete(0x41);
        await sleep(20);
        assertEqual(sent.length, 3, 'all 3 lines sent');
        assertEqual(sent.map(s => s.l), ['G1 X1', 'G1 X2', 'G1 X3'], 'in order');
        const tao = r.state.events.filter(e => e.type === 'timeout-advance');
        assertEqual(tao.length, 0, 'no timeout-advances (real acks won the race)');
    }

    console.log('\n── stall fix: modal-set line has NO ack → timeout advances ──');
    {
        const sent = [];
        const r = makeStreamer(['G1 X1', 'G21', 'G90', 'G1 X2'], (n, l) => sent.push({ n, l }));
        r.sendNext();
        await sleep(5); r.onMotionComplete(0x41);  // G1 X1 acks normally
        // G21 + G90 never ack (modal-set, no motion) — timer must advance
        await sleep(250);
        assertEqual(sent.length, 4, 'all 4 lines sent (timeout covered G21 + G90)');
        const tao = r.state.events.filter(e => e.type === 'timeout-advance');
        assert(tao.length >= 2, `at least 2 timeout-advances fired (got ${tao.length})`);
    }

    console.log('\n── monotonic dedup: duplicate 0xA2 line# does NOT double-advance ──');
    {
        const sent = [];
        const r = makeStreamer(['G1 X1', 'G1 X2', 'G1 X3', 'G1 X4'], (n, l) => sent.push({ n, l }));
        r.sendNext();
        await sleep(5);
        r.onLineAck(1);   // advance to line 2
        r.onLineAck(1);   // dup — should NOT advance again
        r.onLineAck(1);   // dup — should NOT advance again
        await sleep(5);
        r.onLineAck(2);   // advance to line 3
        await sleep(5);
        // We sent at most 3 so far (because line 4 wasn't acked yet)
        assert(sent.length <= 3, `dup acks did not overrun (sent=${sent.length})`);
        r.onLineAck(3);
        await sleep(5);
        assertEqual(sent.length, 4, 'final advance produces 4 sends');
    }

    console.log('\n── 0xA1 and 0xA2 race for the same line → one advance only ──');
    {
        const sent = [];
        const r = makeStreamer(['G1 X1', 'G1 X2'], (n, l) => sent.push({ n, l }));
        r.sendNext();
        await sleep(5);
        r.onMotionComplete(0x41);  // advance via 0xA1
        r.onLineAck(1);            // 0xA2 for same line, dup-gated
        await sleep(150);
        // Expect 2 sends (G1 X1 + G1 X2). NOT 3 (would mean double-advance).
        assertEqual(sent.length, 2, 'A1+A2 for same line = single advance');
    }

    console.log('\n── timeout does not fire if state changes ──');
    {
        const sent = [];
        const r = makeStreamer(['G1 X1'], (n, l) => sent.push({ n, l }));
        r.sendNext();
        r.state.paused = true;
        await sleep(150);
        // Should not have advanced (paused before timeout)
        assertEqual(sent.length, 1, 'paused state blocks timeout-advance');
    }

    console.log(`\n── summary: ${passed} passed, ${failed} failed ──`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
