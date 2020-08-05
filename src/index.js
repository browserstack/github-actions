import * as core from '@actions/core';
import * as exec from '@actions/exec';
import ActionInput from './actionInput';
import BinarySetup from './binarySetup/factory';

const run = async () => {
  try {
    const inputParser = new ActionInput();
    inputParser.fetchAllInput();
    inputParser.setEnvVariables();

    const binarySetup = BinarySetup.getHandler(process.platform);
    await binarySetup.downloadBinary();
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
