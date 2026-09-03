/**
 * errclient - XHR/API error handler middleware.
 *
 * Detects AJAX requests (req.xhr or Accept: application/json) and returns
 * JSON error responses with 500 status. If not an XHR request, passes
 * error to next middleware handler.
 *
 * Reference: gSender errclient.js (GPLv3, Sienci Labs Inc.)
 */

/**
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function errclient(err, req, res, next) {
    // Check if this is an API/XHR request
    const isApi = req.xhr ||
        (req.headers.accept && req.headers.accept.includes('application/json')) ||
        req.path.startsWith('/api/');

    if (isApi) {
        const statusCode = err.status || err.statusCode || 500;
        res.status(statusCode).json({
            error: err.message || 'Internal server error',
        });
        return;
    }

    // Not an API request - pass to next error handler
    next(err);
}

module.exports = errclient;
