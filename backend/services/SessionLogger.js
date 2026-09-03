/**
 * Session logger: writes machine/session data (position, state, console, job events) to a JSON Lines file.
 * One file per connection window; throttle position to ~1s to limit size.
 */
const fs = require('fs');
const path = require('path');

function createSessionLogger(sessionsDir, portPath) {
    const safeName = (portPath || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = path.join(
        sessionsDir,
        `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeName}.ndjson`
    );
    const stream = fs.createWriteStream(filename, { flags: 'a' });
    let lastPositionTime = 0;
    const POSITION_THROTTLE_MS = 1000;

    function write(record) {
        try {
            stream.write(JSON.stringify(record) + '\n');
        } catch (err) {
            // ignore write errors
        }
    }

    return {
        write,
        logConnection(opened, portPathOrReason) {
            write({
                t: Date.now(),
                event: opened ? 'connection:opened' : 'connection:closed',
                port: opened ? portPathOrReason : undefined,
                reason: opened ? undefined : portPathOrReason,
            });
        },
        logState(state) {
            write({ t: Date.now(), event: 'state', state });
        },
        logPosition(pos) {
            const now = Date.now();
            if (now - lastPositionTime >= POSITION_THROTTLE_MS) {
                lastPositionTime = now;
                write({ t: now, ...pos });
            }
        },
        logConsole(text) {
            write({ t: Date.now(), event: 'console', text });
        },
        logJob(payload) {
            write({ t: Date.now(), event: 'job', ...payload });
        },
        close() {
            try {
                stream.end();
            } catch (_) {}
        },
    };
}

module.exports = { createSessionLogger };
