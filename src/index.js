import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as path from 'path';
import ActionInput from './actionInput';
import BinaryControl from './binaryControl';
import constants from '../config/constants';

const {
  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING,
  },
  LOCAL_BINARY_FOLDER
} = constants;

const run = async () => {
  try {
    const inputParser = new ActionInput();
    const stateForBinary = inputParser.getInputStateForBinary();
    const binaryControl = new BinaryControl(stateForBinary);

    if ([LOCAL_TESTING.START, LOCAL_TESTING.FALSE].includes(stateForBinary.localTesting)) {
      inputParser.setEnvVariables();

      if (stateForBinary.localTesting === LOCAL_TESTING.START) {
        await binaryControl.downloadBinary();
        await binaryControl.startBinary();
      }
    } else {
      await binaryControl.stopBinary();
      await exec.exec(`cat ${path.resolve(binaryControl.binaryFolder, LOCAL_BINARY_FOLDER)}`);
      // upload artifacts if any
    }
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
