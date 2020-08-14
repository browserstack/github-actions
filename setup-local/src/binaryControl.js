const tc = require('@actions/tool-cache');
const io = require('@actions/io');
const exec = require('@actions/exec');
const core = require('@actions/core');
const github = require('@actions/github');
const os = require('os');
const path = require('path');
const fs = require('fs');
const ArtifactsManager = require('./artifacts');
const constants = require('../config/constants');

const {
  BINARY_LINKS,
  LOCAL_BINARY_FOLDER,
  PLATFORMS,
  LOCAL_BINARY_NAME,
  LOCAL_LOG_FILE_PREFIX,
  LOCAL_BINARY_TRIGGER,
  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING,
  },
} = constants;

/**
 * BinaryControl handles the operations to be performed on the Local Binary.
 * It takes care of logs generation and triggering the upload as well.
 */
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
      this.binaryFolder = path.resolve(process.env.HOME, 'work', 'binary', LOCAL_BINARY_FOLDER, this.platform);
    } else if (this.platform === PLATFORMS.LINUX) {
      this.binaryLink = os.arch() === 'x32' ? BINARY_LINKS.LINUX_32 : BINARY_LINKS.LINUX_64;
      this.binaryFolder = path.resolve(process.env.HOME, 'work', 'binary', LOCAL_BINARY_FOLDER, this.platform);
    } else if (this.platform === PLATFORMS.WIN32) {
      this.binaryLink = BINARY_LINKS.WINDOWS;
      this.binaryFolder = path.resolve(process.env.GITHUB_WORKSPACE, '..', '..', 'work', 'binary', LOCAL_BINARY_FOLDER, this.platform);
    }
  }

  /**
   * Creates directory recursively for storing Local Binary & its logs.
   */
  async _makeDirectory() {
    await io.mkdirP(this.binaryFolder);
  }

  /**
   * Generates logging file name and its path for Local Binary
   */
  _generateLogFileMetadata() {
    this.logFileName = `${LOCAL_LOG_FILE_PREFIX}_${github.context.job}.log`;
    this.logFilePath = path.resolve(this.binaryFolder, this.logFileName);
  }

  /**
   * Generates the args to be provided for the Local Binary based on the operation, i.e.
   * start/stop.
   * These are generated based on the input state provided to the Binary Control.
   */
  _generateArgsForBinary() {
    const {
      accessKey: key,
      localArgs,
      localIdentifier,
      localLoggingLevel: verbose,
      localTesting: binaryAction,
    } = this.stateForBinary;

    let argsString = `--key ${key} --only-automate --ci-plugin GitHubAction `;

    switch (binaryAction) {
      case LOCAL_TESTING.START: {
        if (localArgs) argsString += `${localArgs} `;
        if (localIdentifier) argsString += `--local-identifier ${localIdentifier} `;
        if (verbose) {
          this._generateLogFileMetadata();
          argsString += `--verbose ${verbose} --log-file ${this.logFilePath} `;
        }
        break;
      }
      case LOCAL_TESTING.STOP: {
        if (localIdentifier) argsString += `--local-identifier ${localIdentifier} `;
        break;
      }
      default: {
        throw Error('Invalid Binary Action');
      }
    }

    this.binaryArgs = argsString;
  }

  /**
   * Triggers the Local Binary. It is used for starting/stopping.
   * @param {String} operation start/stop operation
   */
  async _triggerBinary(operation) {
    let triggerOutput = '';
    let triggerError = '';
    await exec.exec(
      `${LOCAL_BINARY_NAME} ${this.binaryArgs} --daemon ${operation}`,
      [],
      {
        listeners: {
          stdout: (data) => {
            triggerOutput += data.toString();
          },
          stderr: (data) => {
            triggerError += data.toString();
          },
        },
      },
    );

    return {
      output: triggerOutput,
      error: triggerError,
    };
  }

  _binaryExists() {
    const localBinary = tc.findAllVersions(LOCAL_BINARY_NAME);
    return localBinary.length ? true : false;
  }

  /**
   * Downloads the Local Binary, extracts it and adds it in the PATH variable
   */
  async downloadBinary() {
    try {
      if (this._binaryExists()) {
        console.log(core.getState('jinga'));
        core.info('BrowserStackLocal binary already exists in cache. Using that instead of downloading again...');
        return;
      }
      await this._makeDirectory();
      core.saveState('jinga', 'lala');
      core.info('Downloading BrowserStackLocal binary...');
      const downloadPath = await tc.downloadTool(this.binaryLink, path.resolve(this.binaryFolder, 'binaryZip'));
      const extractedPath = await tc.extractZip(downloadPath, this.binaryFolder);
      core.info(`BrowserStackLocal binary downloaded & extracted successfuly at: ${extractedPath}`);
      const cachedPath = await tc.cacheDir(extractedPath, LOCAL_BINARY_NAME, '1.0.0');
      core.addPath(cachedPath);
      this.binaryPath = extractedPath;
    } catch (e) {
      throw Error(`BrowserStackLocal binary could not be downloaded due to ${e.message}`);
    }
  }

  /**
   * Starts Local Binary using the args generated for this action
   */
  async startBinary() {
    try {
      this._generateArgsForBinary();
      let { localIdentifier } = this.stateForBinary;
      localIdentifier = localIdentifier ? `with local-identifier=${localIdentifier}` : '';
      core.info(`Starting local tunnel ${localIdentifier} in daemon mode...`);

      const { output, error } = await this._triggerBinary(LOCAL_TESTING.START);

      if (!error) {
        const outputParsed = JSON.parse(output);
        if (outputParsed.state === LOCAL_BINARY_TRIGGER.START.CONNECTED) {
          core.info(`Local tunnel status: ${outputParsed.message}`);
        } else {
          throw Error(JSON.stringify(outputParsed.message));
        }
      } else {
        throw Error(JSON.stringify(error));
      }
    } catch (e) {
      throw Error(`Local tunnel could not be started. Error message from binary: ${e.message}`);
    }
  }

  /**
   * Stops Local Binary using the args generated for this action
   */
  async stopBinary() {
    try {
      this._generateArgsForBinary();
      let { localIdentifier } = this.stateForBinary;
      localIdentifier = localIdentifier ? `with local-identifier=${localIdentifier}` : '';
      core.info(`Stopping local tunnel ${localIdentifier} in daemon mode...`);

      const { output, error } = await this._triggerBinary(LOCAL_TESTING.STOP);

      if (!error) {
        const outputParsed = JSON.parse(output);
        if (outputParsed.status === LOCAL_BINARY_TRIGGER.STOP.SUCCESS) {
          core.info(`Local tunnel stopping status: ${outputParsed.message}`);
        } else {
          throw Error(JSON.stringify(outputParsed.message));
        }
      } else {
        throw Error(JSON.stringify(error));
      }
    } catch (e) {
      core.info(`[Warning] Error in stopping local tunnel: ${e.message}. Continuing the workflow without breaking...`);
    }
  }

  /**
   * Uploads BrowserStackLocal generated logs (if the file exists for the job)
   */
  async uploadLogFilesIfAny() {
    core.saveState
    this._generateLogFileMetadata();
    if (fs.existsSync(this.logFilePath)) {
      await ArtifactsManager.uploadArtifacts(
        this.logFileName,
        [this.logFilePath],
        this.binaryFolder,
      );
      await io.rmRF(this.logFilePath);
    }
  }
}

module.exports = BinaryControl;
