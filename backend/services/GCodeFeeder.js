/**
 * G-code feeder: hold lines, start/pause/resume/stop, send one-by-one on "ok".
 * Emits: progress, started, paused, stopped.
 */
const EventEmitter = require('events');

const STATES = { idle: 'idle', running: 'running', paused: 'paused', stopped: 'stopped' };

class GCodeFeeder extends EventEmitter {
    constructor(grblController) {
        super();
        this.controller = grblController;
        this.lines = [];
        this.totalLines = 0;
        this.currentIndex = 0;
        this.state = STATES.idle;
        this._abort = false;

        this.controller.on('ok', () => this._onOk());
        this.controller.on('error', () => this._onError());
    }

    load(content) {
        const raw = typeof content === 'string' ? content : content.content || '';
        this.lines = raw
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith(';') && !l.startsWith('('));
        this.totalLines = this.lines.length;
        this.currentIndex = 0;
        this.state = STATES.idle;
        this.emit('loaded', { totalLines: this.totalLines });
    }

    start(startFromLine = 0) {
        if (this.lines.length === 0) {
            this.emit('error', { message: 'No g-code loaded' });
            return;
        }
        this.currentIndex = Math.max(0, Math.min(startFromLine, this.lines.length - 1));
        this.state = STATES.running;
        this._abort = false;
        this.emit('started');
        this._sendNext();
    }

    pause() {
        if (this.state !== STATES.running) return;
        this.state = STATES.paused;
        this.controller.feedHold();
        this.emit('paused', { currentLine: this.currentIndex, totalLines: this.totalLines });
    }

    resume() {
        if (this.state !== STATES.paused) return;
        this.state = STATES.running;
        this.controller.cycleStart();
        this._sendNext();
    }

    stop() {
        this._abort = true;
        this.state = STATES.stopped;
        this.controller.feedHold();
        this.controller.softReset();
        this.emit('stopped');
    }

    _onOk() {
        if (this.state !== STATES.running || this._abort) return;
        this._sendNext();
    }

    _onError() {
        if (this.state === STATES.running) {
            this.state = STATES.stopped;
            this.emit('stopped');
        }
    }

    _sendNext() {
        if (this._abort || this.state !== STATES.running) return;
        if (this.currentIndex >= this.lines.length) {
            this.state = STATES.idle;
            this.emit('completed');
            return;
        }
        const line = this.lines[this.currentIndex];
        this.controller.expectOk();
        this.controller.send(line);
        const progress = this.totalLines ? (this.currentIndex / this.totalLines) * 100 : 0;
        this.emit('progress', {
            currentLine: this.currentIndex,
            totalLines: this.totalLines,
            progress,
        });
        this.currentIndex += 1;
    }

    getState() {
        return this.state;
    }

    getProgress() {
        return {
            currentLine: this.currentIndex,
            totalLines: this.totalLines,
            progress: this.totalLines ? (this.currentIndex / this.totalLines) * 100 : 0,
        };
    }
}

module.exports = { GCodeFeeder, STATES };
