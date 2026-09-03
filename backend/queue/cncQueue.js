/**
 * Bull queue for CNC jobs. Processes one job at a time; g-code is sent to the motion controller
 * only via GCodeFeeder (one line at a time on "ok"). Requires Redis (REDIS_URL or redis://localhost:6379).
 */
const Queue = require('bull');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE_NAME = 'cnc-jobs';

function createCncQueue(gcodeFeeder, emitToClients) {
    const queue = new Queue(QUEUE_NAME, REDIS_URL, {
        defaultJobOptions: { removeOnComplete: 500, attempts: 1 },
    });

    queue.process(
        async (job) => {
            const { content, startFromLine = 0 } = job.data;
            if (!content || typeof content !== 'string') {
                throw new Error('Missing g-code content');
            }
            await new Promise((resolve, reject) => {
                const onDone = () => {
                    gcodeFeeder.removeListener('completed', onDone);
                    gcodeFeeder.removeListener('stopped', onDone);
                    gcodeFeeder.removeListener('error', onErr);
                    resolve();
                };
                const onErr = (e) => {
                    gcodeFeeder.removeListener('completed', onDone);
                    gcodeFeeder.removeListener('stopped', onDone);
                    gcodeFeeder.removeListener('error', onErr);
                    reject(new Error(e?.message || 'Job error'));
                };
                gcodeFeeder.once('completed', onDone);
                gcodeFeeder.once('stopped', onDone);
                gcodeFeeder.once('error', onErr);
                gcodeFeeder.load(content);
                gcodeFeeder.start(startFromLine);
            });
        },
        { concurrency: 1 }
    );

    queue.on('completed', (job) => {
        if (emitToClients) emitToClients('queue:jobCompleted', { jobId: job.id.toString() });
    });
    queue.on('failed', (job, err) => {
        if (emitToClients) emitToClients('queue:jobFailed', { jobId: job.id.toString(), error: err.message });
    });
    queue.on('error', (err) => {
        if (emitToClients) emitToClients('queue:error', { message: err.message });
    });

    async function addJob(data) {
        const job = await queue.add(data);
        const counts = await queue.getJobCounts();
        if (emitToClients) emitToClients('queue:position', { jobId: job.id.toString(), ...counts });
        return { jobId: job.id.toString(), ...counts };
    }

    async function getCounts() {
        return queue.getJobCounts();
    }

    return { queue, addJob, getCounts };
}

module.exports = { createCncQueue, REDIS_URL, QUEUE_NAME };
