import * as core from '@actions/core';
import ParseInput from './parseInput';
import BinarySetup from './binarySetup/factory';

const run = () => {
  try {
    const inputParser = new ParseInput();
    inputParser.fetchAllInput();
    inputParser.setEnvVariables();
    core.info(`ENV variables: ${process.env.BROWSERSTACK_USERNAME}, ${process.env.BROWSERSTACK_PROJECT_NAME}, ${process.env.BROWSERSTACK_BUILD_NAME}, ${process.env.BROWSERSTACK_LOCAL_IDENTIFIER}`);
    const binarySetup = BinarySetup.getHandler(process.platform);
    binarySetup.downloadBinary();
    core.info(`PATH VALUE: ${process.env.PATH}`);
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
