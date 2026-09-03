/**
 * urljoin - URL path joiner with normalization.
 *
 * Combines multiple URL path segments with forward slashes,
 * normalizing double slashes while preserving protocol :// sequences.
 *
 * Reference: gSender urljoin.js (GPLv3, Sienci Labs Inc.)
 */

/**
 * Join URL path segments.
 *
 * @param {...string} parts - URL segments to join
 * @returns {string} Normalized URL
 *
 * @example
 *   urljoin('http://host', '/path/', '/file')  // 'http://host/path/file'
 *   urljoin('/api', 'v1', 'users')             // '/api/v1/users'
 *   urljoin('http://host', '//double')          // 'http://host/double'
 */
function urljoin(...parts) {
    // Filter out empty/null parts
    const segments = parts.filter((p) => p != null && p !== '');

    if (segments.length === 0) return '';

    // Join with /
    let url = segments
        .map((s) => String(s))
        .join('/');

    // Normalize multiple slashes to single slash, but preserve ://
    url = url.replace(/([^:])\/\/+/g, '$1/');

    // Handle query string and fragment
    const queryIdx = url.indexOf('?');
    const hashIdx = url.indexOf('#');
    const pathEnd = queryIdx >= 0 ? queryIdx : (hashIdx >= 0 ? hashIdx : url.length);

    // Remove trailing slash from path portion (but not root /)
    let pathPart = url.slice(0, pathEnd);
    const rest = url.slice(pathEnd);

    if (pathPart.length > 1 && pathPart.endsWith('/')) {
        pathPart = pathPart.slice(0, -1);
    }

    return pathPart + rest;
}

module.exports = urljoin;
