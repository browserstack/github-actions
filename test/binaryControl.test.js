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
const ArtifactsManager = require('../src/artifacts');
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
        platform: 'darwin',
      }, {
        binary: BINARY_LINKS.LINUX_32,
        folder: `/work/binary/${LOCAL_BINARY_FOLDER}/linux`,
        arch: 'x32',
        platform: 'linux',
      }, {
        binary: BINARY_LINKS.LINUX_64,
        folder: `/work/binary/${LOCAL_BINARY_FOLDER}/linux`,
        arch: 'x64',
        platform: 'linux',
      }, {
        binary: BINARY_LINKS.WINDOWS,
        folder: `/work/binary/${LOCAL_BINARY_FOLDER}/win32`,
        arch: 'x32',
        platform: 'win32',
      },
    ];

    platformAndBinary.forEach((system) => {
      it(`decides the binary and the folder based on the platform and architecture for ${system.platform} - ${system.arch}`, () => {
        sinon.stub(os, 'platform').returns(system.platform);
        sinon.stub(os, 'arch').returns(system.arch);
        const binaryControl = new BinaryControl();
        expect(binaryControl.binaryLink).to.eql(system.binary);
        expect(binaryControl.binaryFolder).to.include(system.folder);
        os.platform.restore();
        os.arch.restore();
      });
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

    it('Generates log-file name and path for Binary', () => {
      sinon.stub(os, 'platform').returns('darwin');
      sinon.stub(github, 'context').value({
        job: 'someJobName',
      });
      const expectedLogFileName = `${LOCAL_LOG_FILE_PREFIX}_${github.context.job}.log`;
      const expectedLogFilePath = path.resolve(path.resolve(process.env.HOME, 'work', 'binary', LOCAL_BINARY_FOLDER, 'darwin'), expectedLogFileName);
      const binaryControl = new BinaryControl();
      binaryControl._generateLogFileMetadata();
      expect(binaryControl.logFileName).to.eq(expectedLogFileName);
      expect(binaryControl.logFilePath).to.eq(expectedLogFilePath);
      os.platform.restore();
    });

    context('Generates args string based on the input to Binary Control & the operation required, i.e. start/stop', () => {
      beforeEach(() => {
        sinon.stub(os, 'platform').returns('darwin');
        sinon.stub(github, 'context').value({
          job: 'someJobName',
        });
      });

      afterEach(() => {
        os.platform.restore();
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

          const expectedFinalArgs = `--key someKey --only-automate --ci-plugin GitHubAction --arg1 val1 --arg2 val2 --local-identifier someIdentifier --verbose 1 --log-file ${process.env.HOME}/work/binary/LocalBinaryFolder/darwin/BrowserStackLocal_someJobName.log `;
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
        sinon.stub(core, 'addPath');
      });

      afterEach(() => {
        core.info.restore();
        core.addPath.restore();
      });

      it('Downloads and sets the binary path without any error', async () => {
        sinon.stub(tc, 'downloadTool').returns('downloadPath');
        sinon.stub(tc, 'extractZip').returns('extractedPath');
        sinon.stub(tc, 'cacheDir').returns('cachedPath');
        await binaryControl.downloadBinary();
        expect(binaryControl.binaryPath).to.eq('extractedPath');
        tc.downloadTool.restore();
        tc.extractZip.restore();
        tc.cacheDir.restore();
      });

      it('Throws error if download of Binary fails', async () => {
        sinon.stub(tc, 'downloadTool').throws(Error('someError'));
        try {
          await binaryControl.downloadBinary();
        } catch (e) {
          expect(e.message).to.eq('BrowserStackLocal binary could not be downloaded due to someError');
        }
        tc.downloadTool.restore();
      });
    });

    context('Start Binary', () => {
      let binaryControl;

      beforeEach(() => {
        binaryControl = new BinaryControl();
        sinon.stub(binaryControl, '_generateArgsForBinary').returns(true);
        sinon.stub(core, 'info');
      });

      afterEach(() => {
        core.info.restore();
      });

      it("Starts the local tunnel successfully (with local identifier) and gets connected if the response state is 'connected'", async () => {
        const response = {
          output: JSON.stringify({
            state: 'connected',
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
        sinon.assert.calledWith(core.info, 'Starting local tunnel with local-identifier=someIdentifier in daemon mode...');
        sinon.assert.calledWith(core.info, 'Local tunnel status: some message');
      });

      it("Starts the local tunnel successfully (without local identifier) and gets connected if the response state is 'connected'", async () => {
        const response = {
          output: JSON.stringify({
            state: 'connected',
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

      it("Fails and doesn't connect the local tunnel if the response state is 'disconnected'", async () => {
        const response = {
          output: JSON.stringify({
            state: 'disconnected',
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
          expect(e.message).to.eq('Local tunnel could not be started. Error message from binary: "some message"');
        }
      });

      it("Fails and doesn't connect if binary throws an error message", async () => {
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
          expect(e.message).to.eq(`Local tunnel could not be started. Error message from binary: ${JSON.stringify(response.error)}`);
        }
      });
    });
  });
});
