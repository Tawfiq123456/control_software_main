/**
 * errlog - Error logger middleware.
 *
 * Simple Express error middleware that logs error stack traces before
 * passing to the next handler. Provides server-side error visibility
 * in console/logs while allowing the error handling chain to continue.
 *
 * Reference: gSender errlog.js (GPLv3, Sienci Labs Inc.)
 */
const logger = require('../logger');

/**
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function errlog(err, req, res, next) {
    logger.error('Unhandled error:', {
        message: err.message,
        stack: err.stack,
        method: req.method,
        url: req.originalUrl || req.url,
        ip: req.ip,
        statusCode: err.status || err.statusCode || 500,
    });

    next(err);
}

module.exports = errlog;
