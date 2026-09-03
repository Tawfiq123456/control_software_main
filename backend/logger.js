/**
 * Winston app logger: console + file. Used for requests, errors, and frontend-sent logs (POST /api/log).
 */
const path = require('path');
const fs = require('fs');
const winston = require('winston');

const logsDir = path.join(__dirname, 'logs');
const sessionsDir = path.join(logsDir, 'sessions');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

// ECSS-E: a Winston transport that forwards log lines to the remote diag
// mirror. Lazy-require to break the dependency cycle (logger ← mirror ← logger).
const TransportStream = require('winston-transport');
class RemoteDiagTransport extends TransportStream {
    constructor(opts) { super(opts); this.name = 'RemoteDiagTransport'; }
    log(info, next) {
        setImmediate(() => this.emit('logged', info));
        try {
            const mirror = require('./services/RemoteDiagMirror');
            mirror.mirrorLog(info.level || 'info', info.message);
        } catch (_) { /* mirror not loaded yet during boot */ }
        next();
    }
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'cnc-backend' },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            ),
        }),
        new winston.transports.File({ filename: path.join(logsDir, 'app.log') }),
        new RemoteDiagTransport(),
    ],
});

module.exports = logger;
module.exports.logsDir = logsDir;
module.exports.sessionsDir = sessionsDir;
