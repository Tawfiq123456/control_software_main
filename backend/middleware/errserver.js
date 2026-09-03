/**
 * errserver - 500 Internal Server Error handler middleware.
 *
 * Final error handler (4-parameter signature) that catches unhandled errors
 * and returns appropriate error responses without exposing stack traces
 * or sensitive error details to end users.
 *
 * Reference: gSender errserver.js (GPLv3, Sienci Labs Inc.)
 */

/**
 * Create a 500 error handler middleware.
 *
 * @param {object} [options]
 * @param {string} [options.message='Internal Server Error']
 * @returns {Function} Express error middleware (4 params)
 */
function errserver(options = {}) {
    const defaultMessage = options.message || 'Internal Server Error';

    // Express error middleware must have 4 parameters
    return (err, req, res, _next) => {
        const statusCode = err.status || err.statusCode || 500;

        res.status(statusCode);

        // JSON response for API requests
        if (req.accepts('json') || req.xhr || req.path.startsWith('/api/')) {
            const response = {
                error: err.message || defaultMessage,
                status: statusCode,
            };

            // Include stack trace in development
            if (process.env.NODE_ENV === 'development') {
                response.stack = err.stack;
            }

            res.json(response);
            return;
        }

        // Plain text fallback
        res.type('txt').send(err.message || defaultMessage);
    };
}

module.exports = errserver;
