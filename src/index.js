import * as core from '@actions/core';
import * as exec from '@actions/exec';
import ParseInput from './parseInput';
import BinarySetup from './binarySetup/factory';

const run = async () => {
  try {
    const inputParser = new ParseInput();
    inputParser.fetchAllInput();
    inputParser.setEnvVariables();
    core.info(`ENV variables: ${process.env.BROWSERSTACK_USERNAME}, ${process.env.BROWSERSTACK_PROJECT_NAME}, ${process.env.BROWSERSTACK_BUILD_NAME}, ${process.env.BROWSERSTACK_LOCAL_IDENTIFIER}`);
    const binarySetup = BinarySetup.getHandler(process.platform);
    await binarySetup.downloadBinary();
    core.info(`PATH VALUE: ${process.env.PATH}`);
    console.log('logging the ls altrh...');
    exec.exec('ls -altrh /home/runner/work/executables/LocalBinaryFolder/linux');
    console.log('running binary now...')
    exec.exec('BrowserStackLocal');
  } catch (e) {
    core.setFailed(`Action Failed: ${e}`);
  }
};

run();
