import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as path from 'path';
import * as artifact from '@actions/artifact';
import ActionInput from './actionInput';
import BinaryControl from './binaryControl';
import constants from '../config/constants';

const {
  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING,
  },
  LOCAL_LOGGING_FILE,
} = constants;

const artifactClient = artifact.create();
const artifactName = 'BrowserStack-Local-Logs';

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
      const loggingFile = path.resolve(binaryControl.binaryFolder, LOCAL_LOGGING_FILE);
      await exec.exec(`cat ${loggingFile}`);
      const response = await artifactClient.uploadArtifact(artifactName, [loggingFile], binaryControl.binaryFolder, { continueOnError: true });
      console.log(`Response for upload: ${JSON.stringify(response)}`);
    }
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
