import * as core from '@actions/core';
import ParseInput from './parseInput';

const run = () => {
  try {
    const inputParser = new ParseInput();
    inputParser.fetchAllInput();
    inputParser.setEnvVariables();
    core.info(`ENV variables: ${process.env.BROWSERSTACK_USERNAME}, ${process.env.BROWSERSTACK_PROJECT_NAME}, ${process.env.BROWSERSTACK_BUILD_NAME}, ${process.env.BROWSERSTACK_LOCAL_IDENTIFIER}`);
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
