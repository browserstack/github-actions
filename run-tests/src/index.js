const core = require('@actions/core');
const ActionInput = require('./actionInput');
const TestRunner = require('./utils');

/**
 * Entry point to initiate the Action.
 * 1. Triggers parsing of action input values
 * 2. Sets the environment variables required for BrowserStack
 */
const run = async () => {
  try {
    ActionInput();
    const testRunner = new TestRunner();
    await testRunner.run();
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
