/**
 * recovery.test.js — Fault-injection tests for the Pause/Resume +
 * Power-Loss Recovery mechanism.
 *
 * Tests run against the real JobResumeStore, RecoveryOrchestrator, and
 * JobStream classes using in-process fakes — no hardware or simulator
 * required.
 *
 * Run: npx jest tests/recovery.test.js --verbose
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

const { JobResumeStore, computeCrc32, DEFAULT_MODAL_STATE, SCHEMA_VERSION } = require('../services/jobresume/JobResumeStore');
const { RecoveryOrchestrator } = require('../services/jobresume/RecoveryOrchestrator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp directory for each test's data. */
function makeTempDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-recovery-test-'));
}

/** Remove a temp directory and all its contents. */
function cleanTempDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/** Build a minimal valid checkpoint for testing. */
function makeCheckpoint(overrides = {}) {
    const gcodeText = overrides.gcodeText || 'G21\nG0 X0 Y0\nG1 X10 Y10 F500\nG1 X20 Y20\nG1 X30 Y30';
    const gcodeHash = crypto.createHash('sha1').update(gcodeText).digest('hex');
    return {
        filename:         'test.nc',
        gcodeText,
        gcodeHash,
        totalLines:       100,
        lastExecutedLine: 50,
        lastConfirmedPos: { x: 10.5, y: 20.3, z: -1.2 },
        modalState: {
            wcs: 'G54',
            units: 'G21',
            distanceMode: 'G90',
            feedMode: 'G94',
            spindleState: 'M3',
            spindleRpm: 18000,
            coolantState: 'M8',
            feedRate: 1500,
            toolNumber: 1,
            feedOverridePct: 100,
        },
        ...overrides,
    };
}

const silentLogger = {
    info:  () => {},
    warn:  () => {},
    error: () => {},
    debug: () => {},
};

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Recovery System', () => {

    // ──────────────────────────────────────────────────────────────────
    // Component 1: JobResumeStore — CRC32 + atomic persistence
    // ──────────────────────────────────────────────────────────────────

    describe('JobResumeStore', () => {
        let dataDir;
        let store;

        beforeEach(() => {
            dataDir = makeTempDataDir();
            store = new JobResumeStore(dataDir, silentLogger);
        });

        afterEach(() => cleanTempDir(dataDir));

        test('checkpoint_save_and_load_roundtrip', () => {
            const cp = makeCheckpoint();
            store.save(cp);

            const loaded = store.load();
            expect(loaded).not.toBeNull();
            expect(loaded.version).toBe(SCHEMA_VERSION);
            expect(loaded.filename).toBe('test.nc');
            expect(loaded.lastExecutedLine).toBe(50);
            expect(loaded.totalLines).toBe(100);
            expect(loaded.lastConfirmedPos).toEqual({ x: 10.5, y: 20.3, z: -1.2 });
            expect(loaded.modalState.spindleState).toBe('M3');
            expect(loaded.modalState.spindleRpm).toBe(18000);
            expect(loaded.modalState.coolantState).toBe('M8');
            expect(loaded.modalState.feedRate).toBe(1500);
            expect(loaded.modalState.units).toBe('G21');
            expect(loaded.modalState.distanceMode).toBe('G90');
            expect(loaded.crc32).toBeDefined();
            expect(loaded.gcodeHash).toBeDefined();
            expect(loaded.savedAt).toBeGreaterThan(0);

            // Verify gcodeHash integrity
            const expectedHash = crypto.createHash('sha1').update(cp.gcodeText).digest('hex');
            expect(loaded.gcodeHash).toBe(expectedHash);
        });

        test('checkpoint_crc_detects_corruption', () => {
            const cp = makeCheckpoint();
            store.save(cp);

            // Corrupt one byte in the saved file
            const filePath = path.join(dataDir, 'job_resume.json');
            const raw = fs.readFileSync(filePath, 'utf8');
            const json = JSON.parse(raw);
            json.lastExecutedLine = 999; // tamper with a field
            fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');

            // Load should return null (CRC mismatch)
            const loaded = store.load();
            expect(loaded).toBeNull();
        });

        test('checkpoint_backup_recovery', () => {
            // Save first checkpoint (creates main file)
            const cp1 = makeCheckpoint({ lastExecutedLine: 25 });
            store.save(cp1);

            // Save second checkpoint (creates .bak from previous main)
            const cp2 = makeCheckpoint({ lastExecutedLine: 50 });
            store.save(cp2);

            // Corrupt the main file
            const mainPath = path.join(dataDir, 'job_resume.json');
            fs.writeFileSync(mainPath, 'corrupted garbage data!!!', 'utf8');

            // Load should fall back to .bak (which has cp1's data)
            const loaded = store.load();
            expect(loaded).not.toBeNull();
            expect(loaded.lastExecutedLine).toBe(25);
        });

        test('checkpoint_gcodeHash_mismatch', () => {
            const cp = makeCheckpoint();
            store.save(cp);

            // Manually modify the gcodeText in the saved file without
            // updating the hash (simulates file corruption)
            const filePath = path.join(dataDir, 'job_resume.json');
            const raw = fs.readFileSync(filePath, 'utf8');
            const json = JSON.parse(raw);
            json.gcodeText = 'TAMPERED G-CODE';
            // Recompute CRC to pass the CRC check but fail the hash check
            const { crc32: _, ...withoutCrc } = json;
            const newCrc = computeCrc32(JSON.stringify(withoutCrc));
            json.crc32 = newCrc;
            fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');

            const loaded = store.load();
            expect(loaded).toBeNull();
        });

        test('clear_removes_all_files', () => {
            store.save(makeCheckpoint());
            expect(store.has()).toBe(true);

            store.clear();
            expect(store.has()).toBe(false);

            // Also verify .bak is gone
            const bakPath = path.join(dataDir, 'job_resume.json.bak');
            expect(fs.existsSync(bakPath)).toBe(false);
        });

        test('has_returns_true_for_backup_only', () => {
            store.save(makeCheckpoint({ lastExecutedLine: 10 }));
            store.save(makeCheckpoint({ lastExecutedLine: 20 }));

            // Remove main file but keep backup
            const mainPath = path.join(dataDir, 'job_resume.json');
            fs.unlinkSync(mainPath);

            expect(store.has()).toBe(true);
        });

        test('atomic_write_survives_process_interruption', () => {
            // Save a valid checkpoint first
            const cp1 = makeCheckpoint({ lastExecutedLine: 30 });
            store.save(cp1);

            // Simulate a crash mid-write: write a .tmp file manually and
            // verify the main file is still intact
            const tmpPath = path.join(dataDir, 'job_resume.json.tmp');
            fs.writeFileSync(tmpPath, 'partial write - simulated crash', 'utf8');

            // Load should still return the valid main file
            const loaded = store.load();
            expect(loaded).not.toBeNull();
            expect(loaded.lastExecutedLine).toBe(30);
        });

        test('concurrent_checkpoint_writes', () => {
            // Rapid-fire 50 saves — verify no corruption
            for (let i = 0; i < 50; i++) {
                store.save(makeCheckpoint({ lastExecutedLine: i }));
            }

            const loaded = store.load();
            expect(loaded).not.toBeNull();
            expect(loaded.lastExecutedLine).toBe(49);
            // CRC should still be valid after all those writes
            expect(loaded.crc32).toBeDefined();
        });

        test('v1_schema_migration', () => {
            // Write a v1-style checkpoint (no version, no modalState, has wcs at top level)
            const v1Record = {
                filename: 'old.nc',
                gcodeText: 'G0 X0',
                gcodeHash: crypto.createHash('sha1').update('G0 X0').digest('hex'),
                totalLines: 10,
                lastExecutedLine: 5,
                wcs: 'G55',
                savedAt: Date.now(),
            };
            const filePath = path.join(dataDir, 'job_resume.json');
            fs.writeFileSync(filePath, JSON.stringify(v1Record), 'utf8');

            const loaded = store.load();
            expect(loaded).not.toBeNull();
            expect(loaded.version).toBe(SCHEMA_VERSION);
            expect(loaded.lastConfirmedPos).toEqual({ x: 0, y: 0, z: 0 });
            expect(loaded.modalState).toBeDefined();
            expect(loaded.modalState.wcs).toBe('G55');
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // Component 4: RecoveryOrchestrator — preamble + validation
    // ──────────────────────────────────────────────────────────────────

    describe('RecoveryOrchestrator', () => {

        test('resume_preamble_restores_state', () => {
            const cp = makeCheckpoint({
                lastConfirmedPos: { x: 50.5, y: 30.2, z: -2.0 },
                modalState: {
                    units: 'G21',
                    distanceMode: 'G91',   // incremental mode
                    feedMode: 'G94',
                    spindleState: 'M3',
                    spindleRpm: 18000,
                    coolantState: 'M8',
                    feedRate: 1500,
                    wcs: 'G55',
                    toolNumber: 2,
                    feedOverridePct: 100,
                },
            });

            const preamble = RecoveryOrchestrator.buildResumePreamble(cp, null, 15);

            // Verify the preamble structure
            expect(preamble).toContain('G21');          // Units
            expect(preamble).toContain('G90');          // Absolute mode for repositioning
            expect(preamble).toContain('G0 Z15');       // Safe Z raise
            expect(preamble.join('\n')).toContain('G0 X50.5 Y30.2'); // XY repositioning
            expect(preamble.join('\n')).toContain('M3 S18000');      // Spindle restore
            expect(preamble.join('\n')).toContain('G4 P2');          // Spindle dwell
            expect(preamble).toContain('M8');           // Coolant restore
            expect(preamble).toContain('F1500');        // Feed rate
            expect(preamble.join('\n')).toContain('G1 Z-2');         // Z plunge back
            expect(preamble).toContain('G91');          // Original distance mode restored
            expect(preamble).toContain('G55');          // Non-default WCS
        });

        test('preamble_skips_defaults', () => {
            const cp = makeCheckpoint({
                lastConfirmedPos: { x: 0, y: 0, z: 0 },
                modalState: {
                    ...DEFAULT_MODAL_STATE,
                    spindleState: 'M5',    // spindle off (default)
                    coolantState: 'M9',    // coolant off (default)
                    distanceMode: 'G90',   // already absolute (default)
                    wcs: 'G54',            // default WCS
                },
            });

            const preamble = RecoveryOrchestrator.buildResumePreamble(cp, null, 10);

            // Should NOT contain spindle/coolant commands (they're at defaults)
            const joined = preamble.join('\n');
            expect(joined).not.toContain('M3');
            expect(joined).not.toContain('M4');
            expect(joined).not.toContain('M8');
            expect(joined).not.toContain('M7');
            // Should NOT restore G91 (already in G90)
            // Should NOT restore G55 (already G54)
            const g91Count = preamble.filter(l => l === 'G91').length;
            expect(g91Count).toBe(0);
            const g55Count = preamble.filter(l => l === 'G55').length;
            expect(g55Count).toBe(0);
        });

        test('validateCheckpoint_rejects_invalid', () => {
            expect(RecoveryOrchestrator.validateCheckpoint(null).valid).toBe(false);
            expect(RecoveryOrchestrator.validateCheckpoint({}).valid).toBe(false);
            expect(RecoveryOrchestrator.validateCheckpoint({
                gcodeText: 'G0 X0',
                gcodeHash: 'abc',
                lastExecutedLine: -1,
                totalLines: 10,
            }).valid).toBe(false);
            expect(RecoveryOrchestrator.validateCheckpoint({
                gcodeText: 'G0 X0',
                gcodeHash: 'abc',
                lastExecutedLine: 100,
                totalLines: 100,
            }).valid).toBe(false); // completed job
        });

        test('validateCheckpoint_accepts_valid', () => {
            const cp = makeCheckpoint();
            const result = RecoveryOrchestrator.validateCheckpoint(cp);
            expect(result.valid).toBe(true);
        });

        test('computeResumeLine_default', () => {
            const cp = makeCheckpoint({ lastExecutedLine: 50 });
            const line = RecoveryOrchestrator.computeResumeLine(cp);
            expect(line).toBe(51);
        });

        test('computeResumeLine_with_planner_state', () => {
            const cp = makeCheckpoint({ lastExecutedLine: 50 });
            // If firstUnconfirmed is 48 (two lines in planner not yet executed)
            const line = RecoveryOrchestrator.computeResumeLine(cp, { firstUnconfirmed: 48 });
            expect(line).toBe(48); // Should resume from 48, not 51
        });

        test('computeResumeLine_floor_at_1', () => {
            const cp = makeCheckpoint({ lastExecutedLine: 0 });
            const line = RecoveryOrchestrator.computeResumeLine(cp);
            expect(line).toBe(1);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // Component 6: JobStream planner buffer accounting
    // ──────────────────────────────────────────────────────────────────

    describe('JobStream planner state', () => {
        // We test the JobStream's plannerState() method by constructing a
        // minimal scenario with mocked stream.
        let JobStream;

        beforeAll(() => {
            ({ JobStream } = require('../services/rsp/job'));
        });

        test('plannerState_tracks_sent_vs_executed', () => {
            // Create a minimal mock stream
            const EventEmitter = require('events');
            const mockStream = new EventEmitter();
            mockStream.linkOk = true;
            mockStream.available = 8;
            mockStream.setHeartbeatPaused = () => {};
            mockStream.sendCommand = () => Promise.resolve();
            mockStream.sendNowait = () => 1; // fake seq

            const job = new JobStream(mockStream, { logger: silentLogger, depth: 8 });

            // Upload a job
            job.upload(['G0 X1', 'G0 X2', 'G0 X3', 'G0 X4', 'G0 X5']);

            // Manually simulate: 5 lines sent, 3 executed
            job._sentLines.add(1);
            job._sentLines.add(2);
            job._sentLines.add(3);
            job._sentLines.add(4);
            job._sentLines.add(5);
            job._sentUpTo = 5;
            job._executed.add(1);
            job._executed.add(2);
            job._executed.add(3);
            job._nextLine = 4;

            const ps = job.plannerState();
            expect(ps.lastExecuted).toBe(3);
            expect(ps.firstUnconfirmed).toBe(4);
            expect(ps.inPlannerCount).toBe(2); // lines 4,5 in planner

            job.destroy();
        });

        test('lastConfirmedPos_updated_from_executed', () => {
            const EventEmitter = require('events');
            const { FT_EVT } = require('../services/rsp/frame');
            const defs = require('../services/rsp/defs');
            const codec = require('../services/rsp/codec');

            const mockStream = new EventEmitter();
            mockStream.linkOk = true;
            mockStream.available = 8;
            mockStream.setHeartbeatPaused = () => {};
            mockStream.sendCommand = () => Promise.resolve();
            mockStream.sendNowait = () => 1;

            const job = new JobStream(mockStream, { logger: silentLogger });
            const jobId = job.upload(['G0 X10 Y20 Z-1']);

            // Simulate EV_EXECUTED event with position
            const payload = Buffer.alloc(1 + 16);
            payload.writeUInt8(defs.EV_EXECUTED, 0);
            payload.writeUInt16LE(jobId, 1);
            payload.writeUInt16LE(1, 3);     // lineNo
            payload.writeFloatLE(10.0, 5);   // x
            payload.writeFloatLE(20.0, 9);   // y
            payload.writeFloatLE(-1.0, 13);  // z

            mockStream.emit('event', {
                frameType: FT_EVT,
                payload,
            });

            expect(job.lastConfirmedPos).toEqual({ x: 10, y: 20, z: -1 });

            job.destroy();
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // CRC32 utility
    // ──────────────────────────────────────────────────────────────────

    describe('computeCrc32', () => {
        test('known_vector', () => {
            // CRC32 of "123456789" is 0xCBF43926 (standard IEEE test vector)
            const crc = computeCrc32('123456789');
            expect(crc).toBe('cbf43926');
        });

        test('empty_string', () => {
            const crc = computeCrc32('');
            expect(crc).toBe('00000000');
        });

        test('buffer_input', () => {
            const buf = Buffer.from('hello');
            const crcBuf = computeCrc32(buf);
            const crcStr = computeCrc32('hello');
            expect(crcBuf).toBe(crcStr);
        });
    });
});
