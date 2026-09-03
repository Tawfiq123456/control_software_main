/**
 * TaskRunner - Background task execution service.
 *
 * Spawns shell commands in detached child processes and tracks
 * their lifecycle. Useful for long-running operations like
 * firmware compilation, file processing, or system diagnostics.
 *
 * Reference: gSender TaskRunner.js (GPLv3, Sienci Labs Inc.)
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');

class TaskRunner extends EventEmitter {
    constructor() {
        super();
        this.tasks = [];
    }

    /**
     * Run a shell command as a background task.
     *
     * @param {string} command - Command to execute
     * @param {string} [title] - Task title for tracking
     * @param {object} [options] - spawn() options
     * @returns {string} taskId
     */
    run(command, title, options) {
        if (options === undefined && typeof title === 'object') {
            options = title;
            title = '';
        }

        const taskId = crypto.randomBytes(8).toString('hex');
        const child = spawn(command, [], {
            detached: true,
            shell: true,
            ...options,
        });

        child.unref();

        this.tasks.push(taskId);
        this.emit('start', taskId);

        child.stdout?.on('data', (data) => {
            process.stdout.write(`PID:${child.pid}> ${data}`);
            this.emit('stdout', taskId, data.toString());
        });

        child.stderr?.on('data', (data) => {
            process.stderr.write(`PID:${child.pid}> ${data}`);
            this.emit('stderr', taskId, data.toString());
        });

        child.on('error', (err) => {
            console.error(`TaskRunner: Failed to start task: ${err.message}`);
            this.tasks = this.tasks.filter(id => id !== taskId);
            this.emit('error', taskId, err);
        });

        child.on('exit', (code) => {
            if (this.contains(taskId)) {
                this.tasks = this.tasks.filter(id => id !== taskId);
                this.emit('finish', taskId, code);
            }
        });

        return taskId;
    }

    /**
     * Check if a task ID is currently running.
     */
    contains(taskId) {
        return this.tasks.includes(taskId);
    }

    /**
     * Get all active task IDs.
     */
    getActiveTasks() {
        return [...this.tasks];
    }
}

module.exports = TaskRunner;
