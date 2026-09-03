/**
 * FSMonitor - File system monitor using chokidar.
 *
 * Watches a directory tree for file changes and maintains an
 * in-memory cache of file stats. Used for monitoring G-code files
 * and project directories.
 *
 * Reference: gSender FSMonitor.js (GPLv3, Sienci Labs Inc.)
 */

const { EventEmitter } = require('events');
const chokidar = require('chokidar');
const path = require('path');

class FSMonitor extends EventEmitter {
    constructor() {
        super();
        this.watcher = null;
        this.root = null;
        this.files = {};
    }

    /**
     * Start watching a directory.
     * @param {string} watchDirectory - Path to watch
     */
    watch(watchDirectory) {
        if (this.watcher) {
            this.unwatch();
        }

        this.root = path.resolve(watchDirectory);
        this.files = {};

        this.watcher = chokidar.watch(this.root, {
            persistent: true,
            ignoreInitial: false,
            followSymlinks: false,
            depth: 10,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100,
            },
        });

        this.watcher
            .on('add', (filePath, stats) => {
                this.files[filePath] = stats;
                this.emit('add', filePath, stats);
            })
            .on('change', (filePath, stats) => {
                this.files[filePath] = stats;
                this.emit('change', filePath, stats);
            })
            .on('unlink', (filePath) => {
                delete this.files[filePath];
                this.emit('unlink', filePath);
            })
            .on('addDir', (dirPath, stats) => {
                this.files[dirPath] = stats;
                this.emit('addDir', dirPath, stats);
            })
            .on('unlinkDir', (dirPath) => {
                delete this.files[dirPath];
                this.emit('unlinkDir', dirPath);
            })
            .on('error', (error) => {
                console.error('FSMonitor error:', error);
                this.emit('error', error);
            })
            .on('ready', () => {
                this.emit('ready');
            });
    }

    /**
     * Stop watching.
     */
    async unwatch() {
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
            this.root = null;
            this.files = {};
        }
    }

    /**
     * Get all tracked files.
     */
    getFiles() {
        return { ...this.files };
    }

    /**
     * Get stats for a specific file.
     */
    getStats(filePath) {
        return this.files[filePath];
    }
}

module.exports = FSMonitor;
