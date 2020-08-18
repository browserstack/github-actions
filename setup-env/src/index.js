const core = require('@actions/core');
const ActionInput = require('./actionInput');

/**
 * Entry point to initiate the Action.
 * 1. Triggers parsing of action input values
 * 2. Sets the environment variables required for BrowserStack
 */
const run = async () => {
  try {
    const inputParser = new ActionInput();
    inputParser.setEnvVariables();
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
