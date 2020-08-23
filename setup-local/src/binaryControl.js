const tc = require('@actions/tool-cache');
const io = require('@actions/io');
const exec = require('@actions/exec');
const core = require('@actions/core');
const github = require('@actions/github');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Utils = require('./utils');
const ArtifactsManager = require('./artifactsManager');
const constants = require('../config/constants');

const {
  BINARY_LINKS,
  LOCAL_BINARY_FOLDER,
  PLATFORMS,
  LOCAL_BINARY_NAME,
  LOCAL_LOG_FILE_PREFIX,
  LOCAL_BINARY_TRIGGER,
  BINARY_MAX_TRIES,
  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING,
  },
  ENV_VARS: {
    BROWSERSTACK_LOCAL_LOGS_FILE,
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
    switch (this.platform) {
      case PLATFORMS.DARWIN:
        this.binaryLink = BINARY_LINKS.DARWIN;
        this.binaryFolder = path.resolve(process.env.HOME, 'work', 'binary', LOCAL_BINARY_FOLDER, this.platform);
        break;
      case PLATFORMS.LINUX:
        this.binaryLink = os.arch() === 'x32' ? BINARY_LINKS.LINUX_32 : BINARY_LINKS.LINUX_64;
        this.binaryFolder = path.resolve(process.env.HOME, 'work', 'binary', LOCAL_BINARY_FOLDER, this.platform);
        break;
      case PLATFORMS.WIN32:
        this.binaryLink = BINARY_LINKS.WINDOWS;
        this.binaryFolder = path.resolve(process.env.GITHUB_WORKSPACE, '..', '..', 'work', 'binary', LOCAL_BINARY_FOLDER, this.platform);
        break;
      default:
        throw Error(`Unsupported Platform: ${this.platform}. No BrowserStackLocal binary found.`);
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
    this.logFileName = process.env[BROWSERSTACK_LOCAL_LOGS_FILE] || `${LOCAL_LOG_FILE_PREFIX}_${github.context.job}_${Date.now()}.log`;
    this.logFilePath = path.resolve(this.binaryFolder, this.logFileName);
    core.exportVariable(BROWSERSTACK_LOCAL_LOGS_FILE, this.logFileName);
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

  async _removeAnyStaleBinary() {
    const binaryZip = path.resolve(this.binaryFolder, 'binaryZip');
    const previousLocalBinary = path.resolve(
      this.binaryFolder,
      `${LOCAL_BINARY_NAME}${this.platform === PLATFORMS.WIN32 ? '.exe' : ''}`,
    );
    await Promise.all([io.rmRF(binaryZip), io.rmRF(previousLocalBinary)]);
  }

  /**
   * Downloads the Local Binary, extracts it and adds it in the PATH variable
   */
  async downloadBinary() {
    const cachedBinaryPath = Utils.checkToolInCache(LOCAL_BINARY_NAME, '1.0.0');
    if (cachedBinaryPath) {
      core.info('BrowserStackLocal binary already exists in cache. Using that instead of downloading again...');
      // A cached tool is persisted across runs. But the PATH is reset back to its original
      // state between each run. Thus, adding the cached tool path back to PATH again.
      core.addPath(cachedBinaryPath);
      return;
    }

    try {
      await this._makeDirectory();
      core.debug('BrowserStackLocal binary not found in cache. Deleting any stale/existing binary before downloading...');
      this._removeAnyStaleBinary();

      core.info('Downloading BrowserStackLocal binary...');
      const downloadPath = await tc.downloadTool(this.binaryLink, path.resolve(this.binaryFolder, 'binaryZip'));
      // const extractedPath = await tc.extractZip(downloadPath, this.binaryFolder);
      // core.info(`BrowserStackLocal binary downloaded & extracted successfuly at: ${extractedPath}`);
      // const cachedPath = await tc.cacheDir(extractedPath, LOCAL_BINARY_NAME, '1.0.0');
      // core.addPath(cachedPath);
    } catch (e) {
      throw Error(`BrowserStackLocal binary could not be downloaded due to ${e.message}`);
    }
  }

  /**
   * Starts Local Binary using the args generated for this action
   */
  async startBinary() {
    let { localIdentifier } = this.stateForBinary;
    localIdentifier = localIdentifier ? `with local-identifier=${localIdentifier}` : '';
    core.info(`Starting local tunnel ${localIdentifier} in daemon mode...`);

    let triesAvailable = BINARY_MAX_TRIES;

    while (triesAvailable--) {
      try {
        this._generateArgsForBinary();

        // eslint-disable-next-line no-await-in-loop
        const { output, error } = await this._triggerBinary(LOCAL_TESTING.START);

        if (!error) {
          const outputParsed = JSON.parse(output);
          if (outputParsed.state === LOCAL_BINARY_TRIGGER.START.CONNECTED) {
            core.info(`Local tunnel status: ${outputParsed.message}`);
            return;
          }

          throw Error(JSON.stringify(outputParsed.message));
        } else {
          throw Error(JSON.stringify(error));
        }
      } catch (e) {
        if (triesAvailable) {
          core.info(`Error in starting local tunnel: ${e.message}. Trying again in 5 seconds...`);
          // eslint-disable-next-line no-await-in-loop
          await Utils.sleepFor(5000);
        } else {
          throw Error(`Local tunnel could not be started. Error message from binary: ${e.message}`);
        }
      }
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
    this._generateLogFileMetadata();
    if (fs.existsSync(this.logFilePath)) {
      await ArtifactsManager.uploadArtifacts(
        this.logFileName,
        [this.logFilePath],
        this.binaryFolder,
      );
      await io.rmRF(this.logFilePath);
    }
    Utils.clearEnvironmentVariable(BROWSERSTACK_LOCAL_LOGS_FILE);
  }
}

module.exports = BinaryControl;
