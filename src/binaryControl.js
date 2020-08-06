import * as tc from '@actions/tool-cache';
import * as io from '@actions/io';
import * as exec from '@actions/exec';
import * as core from '@actions/core';
import * as os from 'os';
import * as path from 'path';
import constants from '../config/constants';

const {
  BINARY_LINKS,
  LOCAL_BINARY_FOLDER,
  PLATFORMS,
  LOCAL_BINARY_NAME,
  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING,
  },
} = constants;

class BinaryControl {
  constructor(stateForBinary) {
    this.platform = os.platform();
    this.stateForBinary = stateForBinary;

    this._decidePlatformAndBinary();
  }

  /**
   * decides the binary link and the folder to store the binary based on the
   * platform and the architecture
   */
  _decidePlatformAndBinary() {
    if (this.platform === PLATFORMS.DARWIN) {
      this.binaryLink = BINARY_LINKS.DARWIN;
      this.binaryFolder = path.resolve(process.env.HOME, 'work', 'executables', LOCAL_BINARY_FOLDER, this.platform);
    } else if (this.platform === PLATFORMS.LINUX) {
      this.binaryLink = os.arch() === 'x32' ? BINARY_LINKS.LINUX_32 : BINARY_LINKS.LINUX_64;
      this.binaryFolder = path.resolve(process.env.HOME, 'work', 'executables', LOCAL_BINARY_FOLDER, this.platform);
    } else if (this.platform === PLATFORMS.WIN32) {
      this.binaryLink = BINARY_LINKS.WINDOWS;
      this.binaryFolder = path.resolve(process.env.GITHUB_WORKSPACE, '..', '..', 'work', 'executables', LOCAL_BINARY_FOLDER, this.platform);
    }
  }

  async _makeDirectory() {
    await io.mkdirP(this.binaryFolder);
  }

  _generateArgsForBinary() {
    console.log(`GENERATE ARGS: ${JSON.stringify(this.stateForBinary)}, ${this.stateForBinary.accessKey}`);
    const {
      accessKey: key,
      localArgs,
      localIdentifier,
      localLoggingLevel: verbose,
      localTesting: binaryAction,
    } = this.stateForBinary;

    console.log(`CHECK FINAL KEY VALUE HERE: ${key}`);
    let argsString = `--key ${core.getInput('access-key')}-GitHubAction --only-automate `;

    switch (binaryAction) {
      case LOCAL_TESTING.START: {
        if (localArgs) argsString += `${localArgs} `;
        if (localIdentifier) argsString += `--local-identifier ${localIdentifier} `;
        if (verbose) argsString += `--verbose ${verbose} --log-file BrowserStackLocal.log `;
        argsString += '--daemon start ';
        break;
      }
      case LOCAL_TESTING.STOP: {
        if (localIdentifier) argsString += `--local-identifier ${localIdentifier} `;
        argsString += '--daemon stop ';
        break;
      }
      default: {
        throw Error('Invalid Binary Action');
      }
    }

    this.binaryArgs = argsString;
  }

  async _triggerBinary() {
    try {
      await exec.exec(`${LOCAL_BINARY_NAME} ${this.binaryArgs}`);
    } catch (e) {
      throw Error(`Binary Action: ${this.stateForBinary.localTesting} failed with args: ${this.binaryArgs}. Error: ${e.message}`);
    }
  }

  async downloadBinary() {
    try {
      await this._makeDirectory();
      const downloadPath = await tc.downloadTool(this.binaryLink, path.resolve(this.binaryFolder, 'binaryZip'));
      const extractedPath = await tc.extractZip(downloadPath, this.binaryFolder);
      const cachedPath = await tc.cacheDir(extractedPath, LOCAL_BINARY_NAME, '1.0.0');
      core.addPath(cachedPath);
      this.binaryPath = extractedPath;
    } catch (e) {
      core.setFailed(`Downloading Binary Failed: ${e.message}`);
    }
  }

  async startBinary() {
    this._generateArgsForBinary();
    console.log(`Starting Local Binary with args: ${this.binaryArgs}`);
    await this._triggerBinary();
    console.log(`Successfully started Local Binary`);
  }

  async stopBinary() {
    this._generateArgsForBinary();
    console.log(`Stopping Local Binary with args: ${this.binaryArgs}`);
    await this._triggerBinary();
    console.log(`Successfuly stopped Local Binary`);
  }
}

export default BinaryControl;
