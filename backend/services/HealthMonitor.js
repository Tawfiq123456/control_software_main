/**
 * HealthMonitor - Connection health checking and auto-reconnect.
 *
 * Features:
 *   - Periodic ping/pong health checks
 *   - Status report monitoring (detects stale connections)
 *   - Auto-reconnect with exponential backoff
 *   - Connection quality metrics
 *
 * Reference: gSender health check concept
 */
const { EventEmitter } = require('events');

const HEALTH_CHECK_INTERVAL = 10000;   // 10 seconds
const STALE_THRESHOLD = 15000;         // 15 seconds without status = stale
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000;     // 1 second
const RECONNECT_MAX_DELAY = 30000;     // 30 seconds

class HealthMonitor extends EventEmitter {
    constructor() {
        super();

        /** @type {boolean} Whether monitoring is active */
        this.active = false;

        /** @type {number} Timestamp of last status report */
        this.lastStatusTime = 0;

        /** @type {number} Timestamp of last successful pong */
        this.lastPongTime = 0;

        /** @type {number} Number of consecutive failed health checks */
        this.failedChecks = 0;

        /** @type {number} Total health checks performed */
        this.totalChecks = 0;

        /** @type {number} Total successful checks */
        this.successfulChecks = 0;

        /** @type {boolean} Whether auto-reconnect is enabled */
        this.autoReconnect = false;

        /** @type {number} Current reconnect attempt */
        this.reconnectAttempt = 0;

        /** @type {NodeJS.Timeout|null} */
        this._checkTimer = null;

        /** @type {NodeJS.Timeout|null} */
        this._reconnectTimer = null;

        /** @type {Function|null} Reconnect callback */
        this._reconnectFn = null;
    }

    /**
     * Start health monitoring.
     */
    start() {
        this.stop();
        this.active = true;
        this.lastStatusTime = Date.now();
        this.lastPongTime = Date.now();
        this.failedChecks = 0;

        this._checkTimer = setInterval(() => this._performCheck(), HEALTH_CHECK_INTERVAL);
        this.emit('started');
    }

    /**
     * Stop health monitoring.
     */
    stop() {
        this.active = false;
        this.reconnectAttempt = 0;

        if (this._checkTimer) {
            clearInterval(this._checkTimer);
            this._checkTimer = null;
        }
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    /**
     * Record that a status report was received (connection is alive).
     */
    recordStatus() {
        this.lastStatusTime = Date.now();
        this.failedChecks = 0;
        this.reconnectAttempt = 0;
    }

    /**
     * Record a pong response from the frontend.
     */
    recordPong() {
        this.lastPongTime = Date.now();
    }

    /**
     * Set the auto-reconnect function.
     * @param {Function} fn - Async function that attempts reconnection
     */
    setReconnectFunction(fn) {
        this._reconnectFn = fn;
        this.autoReconnect = typeof fn === 'function';
    }

    /**
     * Perform a health check.
     * @private
     */
    _performCheck() {
        this.totalChecks++;
        const now = Date.now();
        const timeSinceStatus = now - this.lastStatusTime;

        if (timeSinceStatus < STALE_THRESHOLD) {
            // Healthy
            this.successfulChecks++;
            this.failedChecks = 0;
            this.emit('healthy', this.getMetrics());
        } else {
            // Stale
            this.failedChecks++;
            this.emit('stale', {
                timeSinceStatus,
                failedChecks: this.failedChecks,
            });

            // Attempt auto-reconnect if configured
            if (this.autoReconnect && this.failedChecks >= 3) {
                this._attemptReconnect();
            }
        }
    }

    /**
     * Attempt auto-reconnection with exponential backoff.
     * @private
     */
    _attemptReconnect() {
        if (!this._reconnectFn) return;
        if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
            this.emit('reconnect:failed', {
                message: 'Max reconnect attempts reached',
                attempts: this.reconnectAttempt,
            });
            return;
        }

        this.reconnectAttempt++;
        const delay = Math.min(
            RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt - 1),
            RECONNECT_MAX_DELAY
        );

        this.emit('reconnect:attempt', {
            attempt: this.reconnectAttempt,
            maxAttempts: MAX_RECONNECT_ATTEMPTS,
            delay,
        });

        this._reconnectTimer = setTimeout(async () => {
            try {
                await this._reconnectFn();
                this.reconnectAttempt = 0;
                this.lastStatusTime = Date.now();
                this.emit('reconnect:success');
            } catch (err) {
                this.emit('reconnect:error', { error: err.message });
            }
        }, delay);
    }

    /**
     * Get connection quality metrics.
     * @returns {object}
     */
    getMetrics() {
        const now = Date.now();
        return {
            active: this.active,
            healthy: this.active && (now - this.lastStatusTime) < STALE_THRESHOLD,
            timeSinceLastStatus: now - this.lastStatusTime,
            timeSinceLastPong: now - this.lastPongTime,
            failedChecks: this.failedChecks,
            totalChecks: this.totalChecks,
            successfulChecks: this.successfulChecks,
            successRate: this.totalChecks > 0
                ? Math.round((this.successfulChecks / this.totalChecks) * 100)
                : 100,
            autoReconnect: this.autoReconnect,
            reconnectAttempt: this.reconnectAttempt,
        };
    }
}

module.exports = { HealthMonitor };
