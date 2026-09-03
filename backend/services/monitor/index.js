/**
 * monitor service - File system monitoring API.
 *
 * Provides a high-level API for watching directories and reading
 * files, with pattern matching support via minimatch.
 *
 * Reference: gSender monitor/index.js (GPLv3, Sienci Labs Inc.)
 */

const fs = require('fs');
const path = require('path');
const minimatch = require('minimatch');
const FSMonitor = require('./FSMonitor');

const monitor = new FSMonitor();

/**
 * Start watching a directory.
 */
function start({ watchDirectory }) {
    monitor.watch(watchDirectory);
}

/**
 * Stop watching.
 */
function stop() {
    monitor.unwatch();
}

/**
 * Get files matching a search pattern.
 *
 * @param {string} searchPath - Pattern like '/uploads/*.gcode'
 * @returns {Array} File info objects
 */
function getFiles(searchPath) {
    const root = monitor.root;
    if (!root) return [];

    const files = Object.keys(monitor.files);
    const pattern = path.join(root, searchPath, '*');

    if (pattern.indexOf(root) !== 0) {
        return [];
    }

    return minimatch
        .match(files, pattern, { matchBase: true })
        .map(file => {
            const stat = monitor.files[file] || {};

            return {
                name: path.basename(file),
                type: getFileType(stat),
                size: stat.size,
                atime: stat.atime,
                mtime: stat.mtime,
                ctime: stat.ctime,
            };
        });
}

/**
 * Get file type character (f=file, d=directory, etc.)
 */
function getFileType(stat) {
    if (stat.isFile()) return 'f';
    if (stat.isDirectory()) return 'd';
    if (stat.isBlockDevice()) return 'b';
    if (stat.isCharacterDevice()) return 'c';
    if (stat.isSymbolicLink()) return 'l';
    if (stat.isFIFO()) return 'p';
    if (stat.isSocket()) return 's';
    return '';
}

/**
 * Read a file from the watched directory.
 */
function readFile(file, callback) {
    const root = monitor.root;
    const filePath = path.join(root, file);

    fs.readFile(filePath, 'utf8', callback);
}

module.exports = {
    start,
    stop,
    getFiles,
    readFile,
    monitor,
};
