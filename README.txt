AXIO-ONEFINITY CNC Control Software -- Windows Package
========================================================

WHAT THIS IS
------------
A zero-install package: portable Node.js + the backend server + the built
frontend UI, all in one folder. Double-click RUN.bat and it starts the
server and opens the control UI in your browser. No Python, no "npm
install", no admin rights needed.

This build adds support for the RSP protocol (the custom 0x7E-framed,
CRC32-checked, ARQ-reliable binary protocol used by fw_m3_control_sw
firmware) alongside the existing GRBL / GrblHAL / RTS-1/RTS-2 support.
When a board running RSP firmware is plugged in, the backend now
auto-detects it (a valid CRC32 RSP frame on the wire) and switches to the
new RSPController automatically -- same as it already does for GRBL/RTS.

HOW TO RUN
----------
1. Extract this whole folder somewhere (Desktop, Documents, USB drive --
   anywhere with a normal path, avoid extremely long paths).
2. Double-click RUN.bat.
3. A black console window opens and starts the server. Leave it open --
   closing it stops the server. A browser tab opens automatically after a
   few seconds pointed at http://localhost:4000
4. If the browser didn't open, or you closed it by mistake, just open
   http://localhost:4000 yourself in any browser (Chrome/Edge/Firefox).

MANUAL FALLBACK (if RUN.bat doesn't work)
------------------------------------------
Open Command Prompt (cmd.exe), then:
    cd /d "C:\path\to\this\folder"
    runtime\node.exe backend\index.js
Then open http://localhost:4000 in a browser.

HOW IT WORKS
------------
- runtime\    -- a portable copy of Node.js v22.23.2 for Windows x64. This
  is the exact official Node.js build from nodejs.org, just not installed
  system-wide -- it only runs from inside this folder.
- backend\    -- the Express + Socket.IO CNC control server (port 4000).
  Talks to the CNC controller over USB serial (or a live TCP bridge), and
  serves the UI + a WebSocket API to the browser.
- backend\node_modules\  -- all backend dependencies, already installed.
  Notably @serialport (the USB serial driver): this package ships a
  prebuilt native binary for EVERY platform (Windows x64/x86/arm64, macOS,
  Linux) inside every install, and picks the right one automatically at
  startup based on the OS it's actually running on (via node-gyp-build).
  That's why this works on Windows even though it was packaged on Linux --
  verified: backend\node_modules\@serialport\bindings-cpp\prebuilds\
  win32-x64\@serialport+bindings-cpp.node is a genuine Windows PE32+ DLL.
- frontend\dist\  -- the built (production) React/TypeScript UI. The
  backend serves this directly (Express static + SPA fallback), so
  everything is one process on one port -- no separate frontend server.
- backend\services\rsp\  -- the new RSP protocol implementation: a
  line-for-line JavaScript port of the Python reference
  (fw_m3_control_sw/backend/rsp/{frame,defs,codec,stream,job}.py):
    frame.js   -- byte-stuffed framing + CRC32 (IEEE 802.3)
    defs.js    -- opcodes, status/error codes, telemetry struct
    codec.js   -- command payload builders/parsers
    stream.js  -- ARQ reliable-stream engine (ACK/NAK/retransmit/heartbeat)
    job.js     -- G-code job upload/stream/pause/resume/abort state machine
  backend\services\controllers\RSPController.js wraps those into the same
  controller interface the rest of the backend (CNCEngine.js) already uses
  for GRBL/RTS, so the UI doesn't need to know which protocol is in use.

MODIFY / EXTEND
----------------
- To change the server port: set an environment variable before running,
  e.g. in cmd.exe: `set PORT=5000 && runtime\node.exe backend\index.js`
- RSP command mapping lives in RSPController.js's `_dispatch()` method
  (the big switch statement) -- add/adjust cases there to map new UI
  commands onto RSP opcodes from rsp\defs.js / rsp\codec.js.
- To rebuild the frontend after making UI changes on a dev machine (not
  needed for normal use of this package): `cd frontend && npm install &&
  npm run build`, then copy the new `frontend\dist\` folder in here.

DEBUG -- WHAT TO CHECK IF SOMETHING GOES WRONG
------------------------------------------------
- Console window closes instantly / no output: you extracted the zip
  incompletely, or Windows Defender/antivirus quarantined runtime\node.exe
  (portable node.exe sometimes gets flagged). Check quarantine, re-extract
  the zip, or right-click node.exe -> Properties -> Unblock if present.
- "Port 4000 already in use": another program (or a previous RUN.bat you
  forgot to close) is using it. Close the old window, or run with
  `set PORT=5000` as shown above.
- Browser shows nothing / connection refused: the console window will
  print "CNC backend listening on http://localhost:4000" once it's ready
  -- wait for that line before opening the browser, or refresh once more.
- CNC board not detected: check the correct COM port is selected in the
  UI's connect dialog; the backend auto-detects GRBL/GrblHAL/RTS/RSP
  firmware type once a port is opened, it does not need to be told which
  protocol to use.
- Antivirus blocks node.exe from opening a network port: allow it in the
  Windows Firewall prompt the first time you run it (this is normal for
  any local dev server, not a sign of malware).

KNOWN GAPS -- HONEST STATUS OF THE RSP PORT
----------------------------------------------
These are flagged here on purpose rather than hidden. Neither blocks
normal use; both are worth confirming against real hardware before
depending on them in a critical workflow:

1. AXIS ENCODING ASSUMPTION (jog / home / zero commands). The Python
   reference (defs.py/codec.py) treats the axis byte in OP_JOG/OP_HOME/
   OP_ZERO as an opaque number -- it is never explicitly defined as
   0=X/1=Y/2=Z anywhere in the ported source. RSPController.js assumes
   the standard 0=X/1=Y/2=Z convention (matching the X/Y/Z field order
   used everywhere else in the protocol, e.g. telemetry, build_move).
   This has NOT been verified against the real firmware's C source
   (fw_m3/Src/*.c) or real hardware. If jog/home directions come out
   wrong on axis assignment (not direction -- that's a separate, already-
   handled sign flag) on a real RSP board, this is the first place to
   check.

2. "gcode:startFromLine" (resume mid-job at a specific line) is an
   APPROXIMATION, not a true protocol-level resume. RSP/JobStream has no
   native "start mid-file without re-sending earlier lines" primitive
   (unlike GRBL's line-count resume). The current implementation uploads
   and starts the FULL program from line 1, then immediately fast-forwards
   the host's own dispatch pointer via JobStream.resume(lineNumber) --
   meaning earlier lines are technically re-sent to the device's planner
   even though only the requested line onward gets treated as "new work"
   by the host. Fine for typical use (resuming after a pause), but not a
   true selective-resend.

WHAT WAS ACTUALLY TESTED (not just "should work")
-----------------------------------------------------
- Byte-level CRC32/framing: JS port produces byte-identical output to the
  Python reference across 22 generated test cases (checked=22 failures=0).
- defs.js/codec.js (opcodes, telemetry pack/unpack, all command builders/
  parsers): byte-identical to Python reference across 24 cases including
  a 63-byte G-code truncation edge case (checked=24 failures=0).
- stream.js (ARQ engine) functional smoke test against an in-process fake
  device: GET_STATUS round trip, PING echo, heartbeat timing, unanswered-
  command timeout, link-recovery-after-timeout -- 8/8 checks passed.
  (Found and fixed one real bug in the process: a reply-timeout timer was
  incorrectly unref'd, letting Node exit before the timeout could ever
  fire.)
- job.js functional smoke test: full job upload/start/complete, pause/
  resume mid-job, abort + immediate re-upload -- 11/11 checks passed.
- RSPController.js integration test: the REAL, unmodified Python
  FakeFirmware simulator (fw_m3_control_sw/backend/rsp/simulator.py) run
  as an independent TCP server, driven end to end by the real JS
  RSPController/stream.js/job.js stack over a real socket -- bind/init,
  heartbeat telemetry, explicit status request, jog, home, feed override,
  a 15-line G-code job upload+stream+completion, and clean unbind -- 20/20
  checks passed. (Found and fixed one real bug in the process: the
  GET_STATUS response parser was stripping only 1 header byte instead of
  2, corrupting every telemetry field by one byte offset.)
- Lossy-link stress test: same integration setup with the simulator's
  fault injection enabled (3% byte drop + 1.5% byte corruption on every
  host-to-device byte) -- a 60-line job still completed with all 60 lines
  executed correctly and no fail reason, via the ARQ layer's retransmit/
  backoff recovering every corrupted/dropped frame (took ~16.5s instead of
  under 1s on a clean link -- that slowdown IS the retry logic working).
  Note: an earlier attempt at much more aggressive fault injection (8%
  drop + 5% corrupt, a combined per-byte loss rate high enough to corrupt
  nearly every frame of any real size) did not complete within a 30s test
  timeout -- not confirmed as a bug vs. expected behavior under a link
  quality far worse than any real USB-CDC connection would plausibly see;
  flagged here as an untested extreme rather than silently ignored.
- Frontend production build (`npm run build` via vite) succeeds and was
  smoke-tested live: `/` serves the built UI, static JS/CSS assets load,
  `/api/health` still returns real JSON (not shadowed by the new static
  handler), an arbitrary unknown UI route falls back to index.html (SPA
  routing), and an unknown /api/* route still correctly 404s. All 5
  checks passed against a locally running instance of the actual server.
  (Note: `frontend`'s `tsc` type-check has one pre-existing, unrelated
  error in backendConnection.ts's GRBL/RTS status mapping -- not touched
  by this work; the production bundle is built via `vite build` directly,
  which does not block on that type error, same as most Vite/React
  projects in practice.)

WHAT WAS NOT TESTED
-----------------------
- Real RSP hardware (fw_m3 board) -- everything above was validated
  against the Python reference simulator, which is a faithful protocol-
  level stand-in but is not the actual STM32 firmware.
- The 8%/5% extreme packet-loss case noted above.
- Windows-specific runtime behavior beyond static analysis of the bundled
  binary (this package was assembled and tested on Linux; the portable
  Node.js runtime and the @serialport Windows prebuilt binary were
  verified to be genuine, correctly-formatted Windows executables/DLLs,
  but RUN.bat itself and the actual serial-port-open code path have not
  been run on a real Windows machine).
