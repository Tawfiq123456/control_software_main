/**
 * Socket.io handlers: connect, disconnect, command, jog, home, unlock;
 * job:load, job:start, job:pause, job:resume, job:stop, job:startFromLine;
 * forward controller state, position, console and job progress to clients.
 */
const { SerialService, DEFAULT_BAUD } = require('./services/SerialService');
const { createController } = require('./services/controllers');
const { GCodeFeeder } = require('./services/GCodeFeeder');
const { createSessionLogger } = require('./services/SessionLogger');
const logger = require('./logger');
let createCncQueue;
try {
    createCncQueue = require('./queue/cncQueue').createCncQueue;
} catch (err) {
    logger.warn('Job queue module not loaded', { message: err.message });
}

const serialService = new SerialService();
const grblController = createController(serialService);
const gcodeFeeder = new GCodeFeeder(grblController);

let currentSessionLogger = null;
let cncQueue = null;

function attachSocketHandlers(io) {
    if (!cncQueue && createCncQueue) {
        try {
            cncQueue = createCncQueue(gcodeFeeder, (event, data) => io.emit(event, data));
        } catch (err) {
            logger.warn('CNC job queue not started (Redis required)', { message: err.message });
        }
    }
    grblController.on('state', (state) => {
        io.emit('controller:state', state);
        if (currentSessionLogger) currentSessionLogger.logState(state);
    });
    grblController.on('position', (pos) => {
        io.emit('controller:position', pos);
        if (currentSessionLogger) currentSessionLogger.logPosition(pos);
    });
    grblController.on('console', (text) => {
        io.emit('controller:console', { type: 'system', text });
        if (currentSessionLogger) currentSessionLogger.logConsole(text);
    });
    
    grblController.on('initialized', (info) => {
        io.emit('controller:initialized', info);
        if (currentSessionLogger) {
            currentSessionLogger.logConnection(true, `Initialized: ${info.firmwareType} ${info.firmwareVersion}`);
        }
    });

    gcodeFeeder.on('progress', (p) => {
        io.emit('job:progress', p);
        if (currentSessionLogger) currentSessionLogger.logJob({ progress: p });
    });
    gcodeFeeder.on('started', () => {
        io.emit('job:started');
        if (currentSessionLogger) currentSessionLogger.logJob({ event: 'started' });
    });
    gcodeFeeder.on('paused', (p) => {
        io.emit('job:paused', p);
        if (currentSessionLogger) currentSessionLogger.logJob({ event: 'paused', ...p });
    });
    gcodeFeeder.on('stopped', () => {
        io.emit('job:stopped');
        if (currentSessionLogger) currentSessionLogger.logJob({ event: 'stopped' });
    });
    gcodeFeeder.on('completed', () => {
        io.emit('job:completed');
        if (currentSessionLogger) currentSessionLogger.logJob({ event: 'completed' });
    });
    gcodeFeeder.on('loaded', (p) => {
        io.emit('job:loaded', p);
        if (currentSessionLogger) currentSessionLogger.logJob({ event: 'loaded', ...p });
    });
    gcodeFeeder.on('error', (e) => {
        io.emit('job:error', e);
        if (currentSessionLogger) currentSessionLogger.logJob({ event: 'error', ...e });
    });

    serialService.on('open', () => io.emit('connection:opened'));
    serialService.on('close', () => {
        if (currentSessionLogger) {
            currentSessionLogger.logConnection(false, 'disconnect');
            currentSessionLogger.close();
            currentSessionLogger = null;
        }
        // Stop any running job on unexpected disconnect
        try { gcodeFeeder.stop(); } catch (_) {}
        io.emit('connection:closed');
    });
    serialService.on('error', (err) => {
        logger.error('Serial port error', { message: err?.message });
        io.emit('connection:error', { message: err?.message || 'Serial port error' });
    });

    io.on('connection', (socket) => {
        socket.emit('controller:state', grblController.getState());
        socket.emit('controller:position', grblController.getPosition());
        const prog = gcodeFeeder.getProgress();
        socket.emit('job:progress', prog);

        socket.on('connect:request', async (payload) => {
            const path = payload.path || payload.port;
            const baudRate = payload.baudRate || DEFAULT_BAUD;
            const network = payload.network || false;
            if (!path) {
                socket.emit('connection:error', { message: 'Missing port path or IP address' });
                return;
            }
            try {
                await serialService.open(path, { baudRate, network });
                if (currentSessionLogger) currentSessionLogger.close();
                currentSessionLogger = createSessionLogger(logger.sessionsDir, path);
                const connType = serialService.getConnectionType();
                currentSessionLogger.logConnection(true, `${path} (${connType})`);
                grblController.onSerialOpen();
                socket.emit('connection:opened', {
                    path,
                    type: connType,
                });
            } catch (err) {
                socket.emit('connection:error', { message: err.message });
            }
        });

        socket.on('disconnect:request', async () => {
            try {
                await serialService.close();
                socket.emit('connection:closed');
            } catch (err) {
                socket.emit('connection:error', { message: err.message });
            }
        });

        socket.on('command', async (port, cmd, ...args) => {
            try {
                if (!serialService.isOpen()) {
                    socket.emit('controller:console', { type: 'error', text: 'Not connected' });
                    return;
                }
                // Dispatch known commands to their handlers
                switch (cmd) {
                    case 'jog': {
                        const params = args[0] || {};
                        const { x, y, z, feedRate } = params;
                        grblController.jog(x, y, z, feedRate || 1000);
                        break;
                    }
                    case 'jog:safe': {
                        const params = args[0] || {};
                        const { x, y, z, feedRate } = params;
                        grblController.jog(x, y, z, feedRate || 1000);
                        break;
                    }
                    case 'jogcancel':
                        grblController.jogCancel();
                        break;
                    case 'homing':
                        grblController.home();
                        break;
                    case 'unlock':
                        grblController.unlock();
                        break;
                    case 'reset':
                        grblController.softReset();
                        break;
                    case 'feedhold':
                        grblController.feedHold();
                        break;
                    case 'cyclestart':
                        grblController.cycleStart();
                        break;
                    case 'checkmode':
                        grblController.checkMode();
                        break;
                    case 'gcode':
                        grblController.send(args[0]);
                        socket.emit('controller:console', { type: 'info', text: `> ${args[0]}` });
                        break;
                    case 'gcode:start':
                        gcodeFeeder.start(0);
                        break;
                    case 'gcode:pause':
                        gcodeFeeder.pause();
                        break;
                    case 'gcode:resume':
                        gcodeFeeder.resume();
                        break;
                    case 'gcode:stop':
                        gcodeFeeder.stop();
                        break;
                    case 'gcode:startFromLine':
                        gcodeFeeder.start(args[0] || 0);
                        break;
                    case 'settings':
                        grblController.getSettings();
                        break;
                    case 'buildinfo':
                        grblController.getBuildInfo();
                        break;
                    case 'parserstate':
                        grblController.getParserState();
                        break;
                    case 'workcoordinates':
                        grblController.getWorkCoordinates();
                        break;
                    default:
                        // Raw command — send directly
                        grblController.send(cmd);
                        socket.emit('controller:console', { type: 'info', text: `> ${cmd}` });
                }
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('jog', (payload) => {
            try {
                const { x, y, z, feedRate } = payload || {};
                grblController.jog(x, y, z, feedRate || 1000);
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('home', () => {
            try {
                grblController.home();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('unlock', () => {
            try {
                grblController.unlock();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('feed_hold', () => {
            try {
                grblController.feedHold();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('cycle_start', () => {
            try {
                grblController.cycleStart();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('soft_reset', () => {
            try {
                grblController.softReset();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('check_mode', () => {
            try {
                grblController.checkMode();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('get_help', () => {
            try {
                grblController.getHelp();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('get_build_info', () => {
            try {
                grblController.getBuildInfo();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('get_work_coordinates', () => {
            try {
                grblController.getWorkCoordinates();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('get_parser_state', () => {
            try {
                grblController.getParserState();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('jog_cancel', () => {
            try {
                grblController.jogCancel();
            } catch (err) {
                socket.emit('controller:console', { type: 'error', text: err.message });
            }
        });

        socket.on('ports:request', async () => {
            try {
                const ports = await serialService.listPorts();
                socket.emit('ports', ports);
            } catch (err) {
                socket.emit('connection:error', { message: err.message });
            }
        });

        socket.on('job:load', (payload) => {
            const content = typeof payload === 'string' ? payload : (payload && payload.content);
            if (!content) {
                socket.emit('job:error', { message: 'Missing g-code content' });
                return;
            }
            gcodeFeeder.load(content);
        });

        // Alias for frontend `controller.loadFile()` which emits 'file:load'.
        // Without this, uploaded G-code never reaches the feeder and START silently fails.
        socket.on('file:load', (payload) => {
            const name = (payload && payload.name) || 'job.gcode';
            const content = typeof payload === 'string' ? payload : (payload && payload.content);
            if (!content) {
                socket.emit('job:error', { message: 'Missing g-code content' });
                return;
            }
            gcodeFeeder.load(content);
            // Echo back so the frontend can flip its `fileLoadedBackend` gate.
            io.emit('file:load', { name, total: gcodeFeeder.totalLines });
        });

        socket.on('job:start', () => {
            gcodeFeeder.start(0);
        });

        socket.on('job:startFromLine', (payload) => {
            const line = typeof payload === 'number' ? payload : (payload && payload.line);
            gcodeFeeder.start(line != null ? line : 0);
        });

        socket.on('job:pause', () => {
            gcodeFeeder.pause();
        });

        socket.on('job:resume', () => {
            gcodeFeeder.resume();
        });

        socket.on('job:stop', () => {
            gcodeFeeder.stop();
        });

        socket.on('job:queue', async (payload) => {
            const content = typeof payload === 'string' ? payload : (payload && payload.content);
            if (!content) {
                socket.emit('job:error', { message: 'Missing g-code content' });
                return;
            }
            if (!cncQueue) {
                socket.emit('queue:error', { message: 'Job queue not available (Redis required)' });
                return;
            }
            try {
                const startFromLine = typeof payload?.startFromLine === 'number' ? payload.startFromLine : 0;
                const result = await cncQueue.addJob({ content, startFromLine });
                socket.emit('queue:position', result);
            } catch (err) {
                logger.error(err);
                socket.emit('queue:error', { message: err.message });
            }
        });

        socket.on('queue:requestCounts', async () => {
            if (!cncQueue) return;
            try {
                const counts = await cncQueue.getCounts();
                socket.emit('queue:position', counts);
            } catch (_) {}
        });
    });
}

module.exports = {
    attachSocketHandlers,
    serialService,
    grblController,
    gcodeFeeder,
};
