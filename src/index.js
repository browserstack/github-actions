import * as core from '@actions/core';
import ActionInput from './actionInput';
import BinaryControl from './binaryControl';
import constants from '../config/constants';

const {
  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING,
  },
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
        // 2. provide required input for its state
        // 3. start binary
      }
    } else {
      await binaryControl.stopBinary();
      // upload artifacts if any
    }
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
