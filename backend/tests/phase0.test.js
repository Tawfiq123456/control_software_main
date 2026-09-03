/**
 * Phase 0 verification: GRBL/grblHAL compatibility, controller factory, GCodeFeeder queue.
 * Run with: node backend/tests/phase0.test.js
 */
const EventEmitter = require('events');

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        passed++;
        console.log(`  PASS  ${label}`);
    } else {
        failed++;
        console.error(`  FAIL  ${label}`);
    }
}

// ── Mock SerialService ──────────────────────────────────────────────────────
class MockSerial extends EventEmitter {
    constructor() {
        super();
        this._open = true;
        this.written = [];
    }
    isOpen() { return this._open; }
    write(data) { this.written.push(data); }
}

// ── 1. GRBLController parser tests ──────────────────────────────────────────
console.log('\n=== 1. GRBLController – status parsing ===');
const { GRBLController } = require('../services/GRBLController');

(function testStandardGRBL() {
    const serial = new MockSerial();
    const ctrl = new GRBLController(serial);

    let lastState = null, lastPos = null;
    ctrl.on('state', (s) => (lastState = s));
    ctrl.on('position', (p) => (lastPos = p));

    // Initial state is already 'idle', so Idle status won't re-emit (correct: no redundant events).
    // Verify the controller's internal state is idle and position is parsed.
    serial.emit('line', '<Idle|MPos:1.000,2.000,3.000|FS:500,12000>');
    assert(ctrl.getState() === 'idle', 'GRBL Idle -> internal state is idle');
    assert(lastPos && lastPos.x === 1 && lastPos.y === 2 && lastPos.z === 3, 'MPos parsed correctly');

    // Standard GRBL Run with WPos
    serial.emit('line', '<Run|WPos:10.5,20.5,30.5|FS:800,0>');
    assert(lastState === 'running', 'GRBL Run -> running');
    assert(lastPos && lastPos.x === 10.5 && lastPos.y === 20.5 && lastPos.z === 30.5, 'WPos parsed correctly');

    // Hold state
    serial.emit('line', '<Hold|MPos:0,0,0>');
    assert(lastState === 'paused', 'GRBL Hold -> paused');

    // Alarm state
    serial.emit('line', '<Alarm|MPos:0,0,0>');
    assert(lastState === 'alarm', 'GRBL Alarm -> alarm');
})();

(function testGrblHAL() {
    const serial = new MockSerial();
    const ctrl = new GRBLController(serial);

    let lastState = null, lastPos = null;
    ctrl.on('state', (s) => (lastState = s));
    ctrl.on('position', (p) => (lastPos = p));

    // grblHAL sends extra tokens like Pn:, A:, Ov:, etc.
    // First move to a different state so we can detect the transition back to idle
    serial.emit('line', '<Run|MPos:0,0,0>');
    lastState = null;
    serial.emit('line', '<Idle|MPos:5.000,6.000,7.000|FS:0,0|Pn:XYZ|Ov:100,100,100|A:S>');
    assert(lastState === 'idle', 'grblHAL Idle with extra tokens -> idle');
    assert(lastPos && lastPos.x === 5 && lastPos.y === 6 && lastPos.z === 7, 'grblHAL MPos parsed despite extra tokens');

    // grblHAL may send "Tool" or "Door" states not in standard GRBL
    // Move to running first so we can detect the default-to-idle transition
    serial.emit('line', '<Run|MPos:0,0,0>');
    lastState = null;
    serial.emit('line', '<Tool|MPos:0,0,0>');
    assert(lastState === 'idle', 'grblHAL unknown state "Tool" -> defaults to idle');

    serial.emit('line', '<Run|MPos:0,0,0>');
    lastState = null;
    serial.emit('line', '<Door:1|MPos:0,0,0>');
    assert(lastState === 'idle', 'grblHAL "Door:1" state -> defaults to idle');

    // grblHAL Jog state (mapped)
    serial.emit('line', '<Jog|MPos:1,1,1|FS:500,0>');
    assert(lastState === 'running', 'grblHAL Jog -> running');

    // grblHAL Home state (mapped)
    serial.emit('line', '<Home|MPos:0,0,0>');
    assert(lastState === 'running', 'grblHAL Home -> running');

    // grblHAL Sleep state (mapped)
    serial.emit('line', '<Sleep|MPos:0,0,0>');
    assert(lastState === 'idle', 'grblHAL Sleep -> idle');
})();

(function testMalformedStatus() {
    const serial = new MockSerial();
    const ctrl = new GRBLController(serial);

    let lastState = null;
    ctrl.on('state', (s) => (lastState = s));

    // Malformed MPos (NaN values) – should not crash, should still parse state
    serial.emit('line', '<Run|MPos:abc,def,ghi|FS:0,0>');
    assert(lastState === 'running', 'Malformed MPos does not crash, state still parsed');

    // Completely empty status
    serial.emit('line', '<>');
    // Should not crash – state might be empty string which maps to idle
    assert(true, 'Empty status <> does not crash');

    // Not a status message at all
    serial.emit('line', 'Grbl 1.1h [\'$\' for help]');
    assert(true, 'Non-status line does not crash');
})();

(function testOkAndError() {
    const serial = new MockSerial();
    const ctrl = new GRBLController(serial);

    let gotOk = false, gotError = null;
    ctrl.on('ok', () => (gotOk = true));
    ctrl.on('error', (e) => (gotError = e));

    serial.emit('line', 'ok');
    assert(gotOk === true, '"ok" line emits ok event');

    serial.emit('line', 'error:20');
    assert(gotError === 'error:20', '"error:20" line emits error event');
})();

// ── 2. Controller factory ───────────────────────────────────────────────────
console.log('\n=== 2. Controller factory ===');
const { createController } = require('../services/controllers');

(function testFactory() {
    const serial = new MockSerial();
    const ctrl = createController(serial);
    assert(ctrl instanceof GRBLController, 'createController returns GRBLController instance');
    assert(typeof ctrl.send === 'function', 'controller has send()');
    assert(typeof ctrl.softReset === 'function', 'controller has softReset()');
    assert(typeof ctrl.jog === 'function', 'controller has jog()');
    assert(typeof ctrl.feedHold === 'function', 'controller has feedHold()');
    assert(typeof ctrl.cycleStart === 'function', 'controller has cycleStart()');
    assert(typeof ctrl.waitOk === 'function', 'controller has waitOk()');
    assert(typeof ctrl.expectOk === 'function', 'controller has expectOk()');
    assert(typeof ctrl.getState === 'function', 'controller has getState()');
    assert(typeof ctrl.getPosition === 'function', 'controller has getPosition()');
    assert(typeof ctrl.onSerialOpen === 'function', 'controller has onSerialOpen()');
})();

// ── 3. GCodeFeeder – one-line-at-a-time queue ───────────────────────────────
console.log('\n=== 3. GCodeFeeder – sequential line queue ===');
const { GCodeFeeder, STATES } = require('../services/GCodeFeeder');

(function testFeederSequential() {
    const serial = new MockSerial();
    const ctrl = new GRBLController(serial);
    const feeder = new GCodeFeeder(ctrl);

    const progressEvents = [];
    let started = false, completed = false;
    feeder.on('started', () => (started = true));
    feeder.on('completed', () => (completed = true));
    feeder.on('progress', (p) => progressEvents.push(p));

    feeder.load('G0 X10\nG1 Y20 F500\nG0 Z5');
    assert(feeder.totalLines === 3, 'load() parses 3 lines');
    assert(feeder.getState() === 'idle', 'state is idle after load');

    feeder.start(0);
    assert(started, 'start() emits started');
    assert(serial.written.length === 1, 'first line sent immediately');
    assert(serial.written[0].includes('G0 X10'), 'first line is G0 X10');
    assert(feeder.getState() === 'running', 'state is running after start');

    // Simulate controller "ok" for first line
    serial.emit('line', 'ok');
    assert(serial.written.length === 2, 'second line sent after ok');
    assert(serial.written[1].includes('G1 Y20 F500'), 'second line is G1 Y20 F500');

    // Simulate controller "ok" for second line
    serial.emit('line', 'ok');
    assert(serial.written.length === 3, 'third line sent after ok');

    // Simulate controller "ok" for third line – should complete
    serial.emit('line', 'ok');
    assert(completed, 'completed emitted after all lines sent and acknowledged');
    assert(feeder.getState() === 'idle', 'state is idle after completion');
    assert(progressEvents.length === 3, 'progress emitted for each line');
})();

(function testFeederPauseResume() {
    const serial = new MockSerial();
    const ctrl = new GRBLController(serial);
    const feeder = new GCodeFeeder(ctrl);

    let paused = false;
    feeder.on('paused', () => (paused = true));

    feeder.load('G0 X1\nG0 X2\nG0 X3\nG0 X4');
    feeder.start(0);

    // Pause after first line sent
    feeder.pause();
    assert(paused, 'pause() emits paused');
    assert(feeder.getState() === 'paused', 'state is paused');
    assert(serial.written.some(w => w.includes('!')), 'feedHold (!) sent on pause');

    // ok arrives while paused – should NOT send next line
    const countBefore = serial.written.length;
    serial.emit('line', 'ok');
    assert(serial.written.length === countBefore, 'no new line sent while paused');

    // Resume
    feeder.resume();
    assert(feeder.getState() === 'running', 'state is running after resume');
    assert(serial.written.some(w => w.includes('~')), 'cycleStart (~) sent on resume');
})();

(function testFeederStop() {
    const serial = new MockSerial();
    const ctrl = new GRBLController(serial);
    const feeder = new GCodeFeeder(ctrl);

    let stopped = false;
    feeder.on('stopped', () => (stopped = true));

    feeder.load('G0 X1\nG0 X2');
    feeder.start(0);
    feeder.stop();
    assert(stopped, 'stop() emits stopped');
    assert(feeder.getState() === 'stopped', 'state is stopped');
    assert(serial.written.some(w => w.includes('\x18')), 'softReset (0x18) sent on stop');
})();

(function testFeederStartFromLine() {
    const serial = new MockSerial();
    const ctrl = new GRBLController(serial);
    const feeder = new GCodeFeeder(ctrl);

    feeder.load('G0 X1\nG0 X2\nG0 X3\nG0 X4');
    feeder.start(2); // start from line index 2
    assert(serial.written[serial.written.length - 1].includes('G0 X3'), 'startFromLine=2 sends third line first');
})();

(function testFeederErrorStops() {
    const serial = new MockSerial();
    const ctrl = new GRBLController(serial);
    const feeder = new GCodeFeeder(ctrl);

    let stopped = false;
    feeder.on('stopped', () => (stopped = true));

    feeder.load('G0 X1\nG0 X2');
    feeder.start(0);

    // Simulate GRBL error
    serial.emit('line', 'error:20');
    assert(stopped, 'feeder stops on controller error');
    assert(feeder.getState() === 'stopped', 'state is stopped after error');
})();

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Phase 0 results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));
process.exit(failed > 0 ? 1 : 0);
