import * as core from '@actions/core';
import * as exec from '@actions/exec';
import ParseInput from './parseInput';
import BinarySetup from './binarySetup/factory';

const run = async () => {
  try {
    const inputParser = new ParseInput();
    inputParser.fetchAllInput();
    inputParser.setEnvVariables();

    const binarySetup = BinarySetup.getHandler(process.platform);
    await binarySetup.downloadBinary();
    exec.exec(`ls -altrh ${binarySetup.getBinaryPath()}`);
    // exec.exec('BrowserStackLocal');
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
