import * as core from '@actions/core';
import * as exec from '@actions/exec';
import ActionInput from './actionInput';
import BinaryControl from './binaryControl';

const run = async () => {
  try {
    const inputParser = new ActionInput();
    inputParser.setEnvVariables();

    const binarySetup = new BinaryControl();
    await binarySetup.downloadBinary();
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
