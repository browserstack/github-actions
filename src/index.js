const core = require('@actions/core');
const ActionInput = require('./actionInput');
const BinaryControl = require('./binaryControl');
const constants = require('../config/constants');

const {
  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING,
  },
} = constants;

/**
 * Entry point to initiate the Action.
 * 1. Triggers parsing of action input values
 * 2. Decides requirement of Local Binary
 * 3. Start/Stop Local Binary if required
 * 4. Triggers uploading of artifacts
 */
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
      await binaryControl.uploadLogFilesIfAny();
    }
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
