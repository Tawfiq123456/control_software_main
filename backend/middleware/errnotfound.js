/**
 * errnotfound - 404 Not Found handler middleware.
 *
 * Handles "Not Found" errors with content negotiation:
 *   - JSON for API requests (Accept: application/json)
 *   - Plain text as fallback
 *
 * Reference: gSender errnotfound.js (GPLv3, Sienci Labs Inc.)
 */

/**
 * Create a 404 handler middleware.
 *
 * @param {object} [options]
 * @param {string} [options.message='Not Found']
 * @returns {import('express').RequestHandler}
 */
function errnotfound(options = {}) {
    const message = options.message || 'Not Found';

    return (req, res, _next) => {
        res.status(404);

        // Content negotiation
        if (req.accepts('json')) {
            res.json({
                error: message,
                status: 404,
                path: req.originalUrl || req.url,
            });
            return;
        }

        // Plain text fallback
        res.type('txt').send(`${message}: ${req.originalUrl || req.url}`);
    };
}

module.exports = errnotfound;
