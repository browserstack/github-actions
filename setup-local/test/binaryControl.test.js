const { expect, assert } = require('chai');
const sinon = require('sinon');
const tc = require('@actions/tool-cache');
const io = require('@actions/io');
const exec = require('@actions/exec');
const core = require('@actions/core');
const path = require('path');
const github = require('@actions/github');
const os = require('os');
const fs = require('fs');
const BinaryControl = require('../src/binaryControl');
const ArtifactsManager = require('../src/artifactsManager');
const constants = require('../config/constants');
const Utils = require('../src/utils');

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
  ENV_VARS: {
    BROWSERSTACK_LOCAL_LOGS_FILE,
  },
} = constants;

describe('Binary Control Operations', () => {
  const earlierGitHubWorkspace = process.env.GITHUB_WORKSPACE;

  beforeEach(() => {
    process.env.GITHUB_WORKSPACE = 'some_workspace';
  });

  afterEach(() => {
    process.env.GITHUB_WORKSPACE = earlierGitHubWorkspace;
  });

  context('Private Methods Behaviour', () => {
    const platformAndBinary = [
      {
        binary: BINARY_LINKS.DARWIN,
        folder: `/work/binary/${LOCAL_BINARY_FOLDER}/darwin`,
        arch: 'x64',
        platform: PLATFORMS.DARWIN,
      }, {
        binary: BINARY_LINKS.LINUX_32,
        folder: `/work/binary/${LOCAL_BINARY_FOLDER}/linux`,
        arch: 'x32',
        platform: PLATFORMS.LINUX,
      }, {
        binary: BINARY_LINKS.LINUX_64,
        folder: `/work/binary/${LOCAL_BINARY_FOLDER}/linux`,
        arch: 'x64',
        platform: PLATFORMS.LINUX,
      }, {
        binary: BINARY_LINKS.WINDOWS,
        folder: `/work/binary/${LOCAL_BINARY_FOLDER}/win32`,
        arch: 'x32',
        platform: PLATFORMS.WIN32,
      },
    ];

    platformAndBinary.forEach((system) => {
      it(`decides the binary and the folder based on the platform and architecture for ${system.platform} - ${system.arch}`, () => {
        sinon.stub(os, 'platform').returns(system.platform);
        sinon.stub(os, 'arch').returns(system.arch);
        sinon.stub(path, 'resolve').returns(system.folder);
        const binaryControl = new BinaryControl();
        expect(binaryControl.binaryLink).to.eql(system.binary);
        expect(binaryControl.binaryFolder).to.eq(system.folder);
        os.platform.restore();
        os.arch.restore();
        path.resolve.restore();
      });
    });

    it(`Throws error and exits the workflow if the platform is not supported`, () => {
      sinon.stub(os, 'platform').returns('somePlatform');
      try {
        // eslint-disable-next-line no-new
        new BinaryControl();
      } catch (e) {
        expect(e.message).to.eq('Unsupported Platform: somePlatform. No BrowserStackLocal binary found.');
      }
      os.platform.restore();
    });

    it('Makes Directory for the binary folder in recursive manner', async () => {
      sinon.stub(io, 'mkdirP').returns(true);
      sinon.stub(os, 'platform').returns('darwin');
      const binaryControl = new BinaryControl();
      await binaryControl._makeDirectory();
      sinon.assert.calledWith(io.mkdirP, path.resolve(process.env.HOME, 'work', 'binary', LOCAL_BINARY_FOLDER, 'darwin'));
      io.mkdirP.restore();
      os.platform.restore();
    });

    context('Log File metadata', () => {
      beforeEach(() => {
        sinon.stub(core, 'exportVariable');
        sinon.stub(os, 'platform').returns('darwin');
        sinon.stub(github, 'context').value({
          job: 'someJobName',
        });
      });

      afterEach(() => {
        delete process.env[BROWSERSTACK_LOCAL_LOGS_FILE];
        core.exportVariable.restore();
        os.platform.restore();
      });

      it('Generates log-file name and path for Binary', () => {
        sinon.stub(Date, 'now').returns('now');
        const expectedLogFileName = `${LOCAL_LOG_FILE_PREFIX}_${github.context.job}_now.log`;
        const expectedLogFilePath = path.resolve(path.resolve(process.env.HOME, 'work', 'binary', LOCAL_BINARY_FOLDER, 'darwin'), expectedLogFileName);
        const binaryControl = new BinaryControl();
        binaryControl._generateLogFileMetadata();
        expect(binaryControl.logFileName).to.eq(expectedLogFileName);
        expect(binaryControl.logFilePath).to.eq(expectedLogFilePath);
        sinon.assert.calledWith(
          core.exportVariable,
          BROWSERSTACK_LOCAL_LOGS_FILE,
          expectedLogFileName,
        );
        Date.now.restore();
      });

      it('Fetches log-file name and generates path for Binary if logs file name was already defined', () => {
        process.env[BROWSERSTACK_LOCAL_LOGS_FILE] = `${LOCAL_LOG_FILE_PREFIX}_${github.context.job}_now.log`;
        const expectedLogFileName = `${LOCAL_LOG_FILE_PREFIX}_${github.context.job}_now.log`;
        const expectedLogFilePath = path.resolve(path.resolve(process.env.HOME, 'work', 'binary', LOCAL_BINARY_FOLDER, 'darwin'), expectedLogFileName);
        const binaryControl = new BinaryControl();
        binaryControl._generateLogFileMetadata();
        expect(binaryControl.logFileName).to.eq(expectedLogFileName);
        expect(binaryControl.logFilePath).to.eq(expectedLogFilePath);
        sinon.assert.calledWith(
          core.exportVariable,
          BROWSERSTACK_LOCAL_LOGS_FILE,
          expectedLogFileName,
        );
      });
    });

    context('Generates args string based on the input to Binary Control & the operation required, i.e. start/stop', () => {
      beforeEach(() => {
        sinon.stub(os, 'platform').returns('darwin');
        sinon.stub(github, 'context').value({
          job: 'someJobName',
        });
        sinon.stub(Date, 'now').returns('now');
        sinon.stub(core, 'exportVariable');
      });

      afterEach(() => {
        os.platform.restore();
        Date.now.restore();
        core.exportVariable.restore();
      });

      context('Start Operation', () => {
        it('with localArgs, localIdentifier, localLoggingLevel', () => {
          const stateForBinary = {
            accessKey: 'someKey',
            localArgs: '--arg1 val1 --arg2 val2',
            localIdentifier: 'someIdentifier',
            localLoggingLevel: 1,
            localTesting: 'start',
          };

          const expectedFinalArgs = `--key someKey --only-automate --ci-plugin GitHubAction --arg1 val1 --arg2 val2 --local-identifier someIdentifier --verbose 1 --log-file ${path.resolve(process.env.HOME, 'work', 'binary', 'LocalBinaryFolder', 'darwin', 'BrowserStackLocal_someJobName_now.log')} `;
          const binaryControl = new BinaryControl(stateForBinary);
          binaryControl._generateArgsForBinary();
          expect(binaryControl.binaryArgs).to.eq(expectedFinalArgs);
        });

        it('with localArgs, localIdentifier', () => {
          const stateForBinary = {
            accessKey: 'someKey',
            localArgs: '--arg1 val1 --arg2 val2',
            localIdentifier: 'someIdentifier',
            localLoggingLevel: 0,
            localTesting: 'start',
          };

          const expectedFinalArgs = `--key someKey --only-automate --ci-plugin GitHubAction --arg1 val1 --arg2 val2 --local-identifier someIdentifier `;
          const binaryControl = new BinaryControl(stateForBinary);
          binaryControl._generateArgsForBinary();
          expect(binaryControl.binaryArgs).to.eq(expectedFinalArgs);
        });

        it('with localArgs', () => {
          const stateForBinary = {
            accessKey: 'someKey',
            localArgs: '--arg1 val1 --arg2 val2',
            localIdentifier: '',
            localLoggingLevel: 0,
            localTesting: 'start',
          };

          const expectedFinalArgs = `--key someKey --only-automate --ci-plugin GitHubAction --arg1 val1 --arg2 val2 `;
          const binaryControl = new BinaryControl(stateForBinary);
          binaryControl._generateArgsForBinary();
          expect(binaryControl.binaryArgs).to.eq(expectedFinalArgs);
        });

        it('with the default args', () => {
          const stateForBinary = {
            accessKey: 'someKey',
            localArgs: '',
            localIdentifier: '',
            localLoggingLevel: 0,
            localTesting: 'start',
          };

          const expectedFinalArgs = `--key someKey --only-automate --ci-plugin GitHubAction `;
          const binaryControl = new BinaryControl(stateForBinary);
          binaryControl._generateArgsForBinary();
          expect(binaryControl.binaryArgs).to.eq(expectedFinalArgs);
        });
      });

      context('Stop operation', () => {
        it('with localIdentifier', () => {
          const stateForBinary = {
            accessKey: 'someKey',
            localArgs: '',
            localIdentifier: 'someIdentifier',
            localLoggingLevel: 0,
            localTesting: 'stop',
          };

          const expectedFinalArgs = `--key someKey --only-automate --ci-plugin GitHubAction --local-identifier someIdentifier `;
          const binaryControl = new BinaryControl(stateForBinary);
          binaryControl._generateArgsForBinary();
          expect(binaryControl.binaryArgs).to.eq(expectedFinalArgs);
        });

        it('without localIdentifier', () => {
          const stateForBinary = {
            accessKey: 'someKey',
            localArgs: '',
            localIdentifier: '',
            localLoggingLevel: 0,
            localTesting: 'stop',
          };

          const expectedFinalArgs = `--key someKey --only-automate --ci-plugin GitHubAction `;
          const binaryControl = new BinaryControl(stateForBinary);
          binaryControl._generateArgsForBinary();
          expect(binaryControl.binaryArgs).to.eq(expectedFinalArgs);
        });
      });

      context('Invalid Operation', () => {
        it('Throws error in case its not start/stop', () => {
          const stateForBinary = {
            accessKey: 'someKey',
            localArgs: '',
            localIdentifier: 'someIdentifier',
            localLoggingLevel: 0,
            localTesting: 'someOperation',
          };

          const binaryControl = new BinaryControl(stateForBinary);
          assert.throw(() => {
            binaryControl._generateArgsForBinary();
          }, 'Invalid Binary Action');
        });
      });
    });

    context('Triggers Binary with the required operation, i.e. start/stop', () => {
      let binaryControl;

      beforeEach(() => {
        sinon.stub(exec, 'exec');
        binaryControl = new BinaryControl();
        binaryControl.binaryArgs = 'someArgs ';
      });

      afterEach(() => {
        exec.exec.restore();
      });

      it('Start Operation', async () => {
        const response = await binaryControl._triggerBinary(LOCAL_TESTING.START);
        sinon.assert.calledWith(exec.exec, `${LOCAL_BINARY_NAME} someArgs  --daemon start`);
        expect(response).to.eql({
          output: '',
          error: '',
        });
      });

      it('Stop Operation', async () => {
        const response = await binaryControl._triggerBinary(LOCAL_TESTING.STOP);
        sinon.assert.calledWith(exec.exec, `${LOCAL_BINARY_NAME} someArgs  --daemon stop`);
        expect(response).to.eql({
          output: '',
          error: '',
        });
      });
    });
  });

  context('Public Methods Behaviour', () => {
    context('Downloading Binary', () => {
      let binaryControl;

      beforeEach(() => {
        binaryControl = new BinaryControl();
        sinon.stub(binaryControl, '_makeDirectory').returns(true);
        binaryControl.binaryLink = 'someLink';
        binaryControl.binaryFolder = 'someFolder';
        sinon.stub(core, 'info');
        sinon.stub(core, 'debug');
        sinon.stub(core, 'addPath');
        sinon.stub(io, 'rmRF');
      });

      afterEach(() => {
        core.info.restore();
        core.debug.restore();
        core.addPath.restore();
        io.rmRF.restore();
      });

      it('Downloads and sets the binary path without any error', async () => {
        sinon.stub(Utils, 'checkToolInCache').returns(false);
        sinon.stub(tc, 'downloadTool').returns('downloadPath');
        sinon.stub(tc, 'extractZip').returns('extractedPath');
        sinon.stub(tc, 'cacheDir').returns('cachedPath');
        sinon.stub(binaryControl, '_removeAnyStaleBinary');
        await binaryControl.downloadBinary();
        sinon.assert.called(binaryControl._removeAnyStaleBinary);
        tc.downloadTool.restore();
        tc.extractZip.restore();
        tc.cacheDir.restore();
        Utils.checkToolInCache.restore();
        binaryControl._removeAnyStaleBinary.restore();
      });

      it('Delete any stale local binary (non windows)', () => {
        binaryControl._removeAnyStaleBinary();
        const binaryZipPath = path.resolve(binaryControl.binaryFolder, 'binaryZip');
        const staleBinaryPath = path.resolve(
          binaryControl.binaryFolder,
          `${LOCAL_BINARY_NAME}`,
        );
        sinon.assert.calledWith(io.rmRF, binaryZipPath);
        sinon.assert.calledWith(io.rmRF, staleBinaryPath);
      });

      it('Delete any stale local binary (windows)', () => {
        binaryControl.platform = PLATFORMS.WIN32;
        binaryControl._removeAnyStaleBinary();
        const binaryZipPath = path.resolve(binaryControl.binaryFolder, 'binaryZip');
        const staleBinaryPath = path.resolve(
          binaryControl.binaryFolder,
          `${LOCAL_BINARY_NAME}.exe`,
        );
        sinon.assert.calledWith(io.rmRF, binaryZipPath);
        sinon.assert.calledWith(io.rmRF, staleBinaryPath);
      });

      it('Uses cached binary if it already exists (was already downloaded)', async () => {
        sinon.stub(Utils, 'checkToolInCache').returns('some/path/of/tool');
        sinon.stub(tc, 'downloadTool').returns('downloadPath');
        sinon.stub(tc, 'extractZip').returns('extractedPath');
        sinon.stub(tc, 'cacheDir').returns('cachedPath');
        await binaryControl.downloadBinary();
        sinon.assert.calledWith(core.info, 'BrowserStackLocal binary already exists in cache. Using that instead of downloading again...');
        sinon.assert.calledWith(core.addPath, 'some/path/of/tool');
        sinon.assert.notCalled(tc.downloadTool);
        sinon.assert.notCalled(tc.extractZip);
        sinon.assert.notCalled(tc.cacheDir);
        sinon.assert.notCalled(binaryControl._makeDirectory);
        tc.downloadTool.restore();
        tc.extractZip.restore();
        tc.cacheDir.restore();
        Utils.checkToolInCache.restore();
      });

      it('Throws error if download of Binary fails', async () => {
        sinon.stub(Utils, 'checkToolInCache').returns(false);
        sinon.stub(tc, 'downloadTool').throws(Error('someError'));
        try {
          await binaryControl.downloadBinary();
        } catch (e) {
          expect(e.message).to.eq('BrowserStackLocal binary could not be downloaded due to someError');
        }
        tc.downloadTool.restore();
        Utils.checkToolInCache.restore();
      });
    });

    context('Triggering Binary to Start/Stop Local Tunnel', () => {
      let binaryControl;

      beforeEach(() => {
        binaryControl = new BinaryControl();
        sinon.stub(binaryControl, '_generateArgsForBinary').returns(true);
        sinon.stub(core, 'info');
        sinon.stub(core, 'debug');
        sinon.stub(Utils, 'sleepFor');
      });

      afterEach(() => {
        core.info.restore();
        core.debug.restore();
        Utils.sleepFor.restore();
      });

      context('Starting Local Tunnel', () => {
        it("Starts the local tunnel successfully (with local identifier) and gets connected if the response state is 'connected'", async () => {
          const response = {
            output: JSON.stringify({
              state: LOCAL_BINARY_TRIGGER.START.CONNECTED,
              pid: 1234,
              message: 'some message',
            }),
            error: '',
          };
          sinon.stub(binaryControl, 'stateForBinary').value({
            localIdentifier: 'someIdentifier',
          });
          sinon.stub(binaryControl, '_triggerBinary').returns(response);
          await binaryControl.startBinary();
          sinon.assert.calledWith(binaryControl._triggerBinary, LOCAL_TESTING.START);
          sinon.assert.calledWith(core.info, 'Starting local tunnel with local-identifier=someIdentifier in daemon mode...');
          sinon.assert.calledWith(core.info, 'Local tunnel status: some message');
        });

        it("Starts the local tunnel successfully (without local identifier) and gets connected if the response state is 'connected'", async () => {
          const response = {
            output: JSON.stringify({
              state: LOCAL_BINARY_TRIGGER.START.CONNECTED,
              pid: 1234,
              message: 'some message',
            }),
            error: '',
          };
          sinon.stub(binaryControl, 'stateForBinary').value({
            localIdentifier: '',
          });
          sinon.stub(binaryControl, '_triggerBinary').returns(response);
          await binaryControl.startBinary();
          sinon.assert.calledWith(core.info, 'Starting local tunnel  in daemon mode...');
          sinon.assert.calledWith(core.info, 'Local tunnel status: some message');
        });

        it("Fails and doesn't connect the local tunnel if the response state is 'disconnected' after each available tries", async () => {
          const response = {
            output: JSON.stringify({
              state: LOCAL_BINARY_TRIGGER.START.DISCONNECTED,
              pid: 1234,
              message: 'some message',
            }),
            error: '',
          };
          sinon.stub(binaryControl, 'stateForBinary').value({
            localIdentifier: 'someIdentifier',
          });
          sinon.stub(binaryControl, '_triggerBinary').returns(response);
          try {
            await binaryControl.startBinary();
          } catch (e) {
            sinon.assert.calledWith(Utils.sleepFor, 5000);
            sinon.assert.calledWith(core.debug, 'Error in starting local tunnel: "some message". Trying again in 5 seconds...');
            expect(e.message).to.eq('Local tunnel could not be started. Error message from binary: "some message"');
          }
        });

        it("Fails and doesn't connect if binary throws an error message after each available tries", async () => {
          const response = {
            output: '',
            error: JSON.stringify({
              key: 'value',
            }),
          };
          sinon.stub(binaryControl, 'stateForBinary').value({
            localIdentifier: 'someIdentifier',
          });
          sinon.stub(binaryControl, '_triggerBinary').returns(response);
          try {
            await binaryControl.startBinary();
          } catch (e) {
            sinon.assert.calledWith(Utils.sleepFor, 5000);
            sinon.assert.calledWith(core.debug, `Error in starting local tunnel: ${JSON.stringify(response.error)}. Trying again in 5 seconds...`);
            expect(e.message).to.eq(`Local tunnel could not be started. Error message from binary: ${JSON.stringify(response.error)}`);
          }
        });
      });

      context('Stopping Local Tunnel', () => {
        it("Stops the local tunnel successfully (with local identifier) if the response status is 'success'", async () => {
          const response = {
            output: JSON.stringify({
              status: LOCAL_BINARY_TRIGGER.STOP.SUCCESS,
              message: 'some message',
            }),
            error: '',
          };
          sinon.stub(binaryControl, 'stateForBinary').value({
            localIdentifier: 'someIdentifier',
          });
          sinon.stub(binaryControl, '_triggerBinary').returns(response);
          await binaryControl.stopBinary();
          sinon.assert.calledWith(binaryControl._triggerBinary, LOCAL_TESTING.STOP);
          sinon.assert.calledWith(core.info, 'Stopping local tunnel with local-identifier=someIdentifier in daemon mode...');
          sinon.assert.calledWith(core.info, 'Local tunnel stopping status: some message');
        });

        it("Stops the local tunnel successfully (without local identifier) if the response status is 'success'", async () => {
          const response = {
            output: JSON.stringify({
              status: LOCAL_BINARY_TRIGGER.STOP.SUCCESS,
              message: 'some message',
            }),
            error: '',
          };
          sinon.stub(binaryControl, 'stateForBinary').value({
            localIdentifier: '',
          });
          sinon.stub(binaryControl, '_triggerBinary').returns(response);
          await binaryControl.stopBinary();
          sinon.assert.calledWith(binaryControl._triggerBinary, LOCAL_TESTING.STOP);
          sinon.assert.calledWith(core.info, 'Stopping local tunnel  in daemon mode...');
          sinon.assert.calledWith(core.info, 'Local tunnel stopping status: some message');
        });

        it("Fails while disconnecting the local tunnel if the response status is not 'success'", async () => {
          const response = {
            output: JSON.stringify({
              status: 'someStatus',
              message: 'some message',
            }),
            error: '',
          };
          sinon.stub(binaryControl, 'stateForBinary').value({
            localIdentifier: '',
          });
          sinon.stub(binaryControl, '_triggerBinary').returns(response);
          await binaryControl.stopBinary();
          sinon.assert.calledWith(binaryControl._triggerBinary, LOCAL_TESTING.STOP);
          sinon.assert.calledWith(core.info, 'Stopping local tunnel  in daemon mode...');
          sinon.assert.calledWith(core.info, '[Warning] Error in stopping local tunnel: "some message". Continuing the workflow without breaking...');
        });

        it("Fails while disconnecting the local tunnel if binanry thrown as error message", async () => {
          const response = {
            output: '',
            error: JSON.stringify({
              key: 'value',
            }),
          };
          sinon.stub(binaryControl, 'stateForBinary').value({
            localIdentifier: '',
          });
          sinon.stub(binaryControl, '_triggerBinary').returns(response);
          await binaryControl.stopBinary();
          sinon.assert.calledWith(binaryControl._triggerBinary, LOCAL_TESTING.STOP);
          sinon.assert.calledWith(core.info, 'Stopping local tunnel  in daemon mode...');
          sinon.assert.calledWith(core.info, `[Warning] Error in stopping local tunnel: ${JSON.stringify(response.error)}. Continuing the workflow without breaking...`);
        });
      });
    });

    context('Uploading log files if they exists', () => {
      let binaryControl;

      beforeEach(() => {
        binaryControl = new BinaryControl();
        sinon.stub(binaryControl, '_generateLogFileMetadata');
        sinon.stub(io, 'rmRF');
        sinon.stub(ArtifactsManager, 'uploadArtifacts').returns(true);
        sinon.stub(Utils, 'clearEnvironmentVariable');
        binaryControl.logFilePath = 'somePath';
        binaryControl.logFileName = 'someName';
        binaryControl.binaryFolder = 'someFolderPath';
      });

      afterEach(() => {
        io.rmRF.restore();
        ArtifactsManager.uploadArtifacts.restore();
        Utils.clearEnvironmentVariable.restore();
      });

      it('Uploads the log files if they exists', async () => {
        sinon.stub(fs, 'existsSync').returns(true);
        await binaryControl.uploadLogFilesIfAny();
        sinon.assert.calledWith(
          ArtifactsManager.uploadArtifacts,
          'someName',
          ['somePath'],
          'someFolderPath',
        );
        sinon.assert.calledWith(io.rmRF, 'somePath');
        sinon.assert.calledWith(Utils.clearEnvironmentVariable, BROWSERSTACK_LOCAL_LOGS_FILE);
        fs.existsSync.restore();
      });

      it("Doesn't upload the log files if they don't exist", async () => {
        sinon.stub(fs, 'existsSync').returns(false);
        await binaryControl.uploadLogFilesIfAny();
        sinon.assert.notCalled(ArtifactsManager.uploadArtifacts);
        sinon.assert.notCalled(io.rmRF);
        sinon.assert.calledWith(Utils.clearEnvironmentVariable, BROWSERSTACK_LOCAL_LOGS_FILE);
        fs.existsSync.restore();
      });
    });
  });
});
