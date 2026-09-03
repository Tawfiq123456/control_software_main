/**
 * taskrunner service - Singleton TaskRunner instance.
 */

const TaskRunner = require('./TaskRunner');

const taskRunner = new TaskRunner();

module.exports = taskRunner;
