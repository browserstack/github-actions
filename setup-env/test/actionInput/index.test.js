const { expect } = require('chai');
const sinon = require('sinon');
const axios = require('axios');
const core = require('@actions/core');
const ActionInput = require('../../src/actionInput');
const InputValidator = require('../../src/actionInput/inputValidator');
const constants = require('../../config/constants');

const {
  INPUT,
  ENV_VARS,
} = constants;

describe('Action Input operations for fetching all inputs, triggering validation and setting env vars', () => {
  context('Fetch and Validate Input', () => {
    let stubbedInput;

    beforeEach(() => {
      stubbedInput = sinon.stub(core, 'getInput');
      sinon.stub(InputValidator, 'updateUsername').returns('validatedUsername');
      sinon.stub(InputValidator, 'validateBuildName').returns('validatedBuildName');
      sinon.stub(InputValidator, 'validateProjectName').returns('validatedProjectName');
      sinon.stub(InputValidator, 'validateGithubAppName').returns('validatedAppName');
      sinon.stub(InputValidator, 'validateGithubToken').returns('validatedToken');

      // Provide required inputs
      stubbedInput.withArgs(INPUT.USERNAME, { required: true }).returns('someUsername');
      stubbedInput.withArgs(INPUT.ACCESS_KEY, { required: true }).returns('someAccessKey');

      process.env.GITHUB_REPOSITORY = 'browserstack/github-actions';
      process.env.GITHUB_RUN_ID = '12345';
      process.env.GITHUB_RUN_ATTEMPT = '2';
    });

    afterEach(() => {
      sinon.restore();
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_RUN_ID;
      delete process.env.GITHUB_RUN_ATTEMPT;
    });

    it('Takes input and validates it successfully', () => {
      stubbedInput.withArgs(INPUT.BUILD_NAME).returns('someBuildName');
      stubbedInput.withArgs(INPUT.PROJECT_NAME).returns('someProjectName');
      const actionInput = new ActionInput();
      expect(actionInput.username).to.eq('validatedUsername');
      expect(actionInput.buildName).to.eq('validatedBuildName');
      expect(actionInput.projectName).to.eq('validatedProjectName');
    });

    it('Records that build-name and project-name were supplied', () => {
      stubbedInput.withArgs(INPUT.BUILD_NAME).returns('someBuildName');
      stubbedInput.withArgs(INPUT.PROJECT_NAME).returns('someProjectName');
      const actionInput = new ActionInput();
      // eslint-disable-next-line no-unused-expressions
      expect(actionInput.buildNameProvided).to.be.true;
      // eslint-disable-next-line no-unused-expressions
      expect(actionInput.projectNameProvided).to.be.true;
    });

    it('Records that build-name and project-name were NOT supplied when absent', () => {
      stubbedInput.withArgs(INPUT.BUILD_NAME).returns('');
      stubbedInput.withArgs(INPUT.PROJECT_NAME).returns('');
      const actionInput = new ActionInput();
      // eslint-disable-next-line no-unused-expressions
      expect(actionInput.buildNameProvided).to.be.false;
      // eslint-disable-next-line no-unused-expressions
      expect(actionInput.projectNameProvided).to.be.false;
    });

    it('Treats a whitespace-only name input as not supplied', () => {
      stubbedInput.withArgs(INPUT.BUILD_NAME).returns('   ');
      stubbedInput.withArgs(INPUT.PROJECT_NAME).returns('\t ');
      const actionInput = new ActionInput();
      // eslint-disable-next-line no-unused-expressions
      expect(actionInput.buildNameProvided).to.be.false;
      // eslint-disable-next-line no-unused-expressions
      expect(actionInput.projectNameProvided).to.be.false;
    });

    it('Takes input and throws error if username is not provided in input', () => {
      stubbedInput.withArgs(INPUT.USERNAME, { required: true }).throws(Error('Username Required'));
      try {
        // eslint-disable-next-line no-new
        new ActionInput();
      } catch (e) {
        expect(e.message).to.eq('Action input failed for reason: Username Required');
      }
    });

    it('Takes input and throws error if access key is not provided in input', () => {
      stubbedInput.withArgs(INPUT.ACCESS_KEY, { required: true }).throws(Error('Access Key Required'));
      try {
        // eslint-disable-next-line no-new
        new ActionInput();
      } catch (e) {
        expect(e.message).to.eq('Action input failed for reason: Access Key Required');
      }
    });

    it('Takes input and validates GitHub token and app name successfully', () => {
      stubbedInput.withArgs(INPUT.GITHUB_TOKEN).returns('someToken');
      stubbedInput.withArgs(INPUT.GITHUB_APP).returns('someApp');
      const actionInput = new ActionInput();
      expect(actionInput.githubToken).to.eq('validatedToken');
      expect(actionInput.githubApp).to.eq('validatedAppName');
    });
  });

  context('Set Environment Variables', () => {
    let actionInput;

    beforeEach(() => {
      sinon.stub(core, 'exportVariable');
      sinon.stub(core, 'info');
      sinon.stub(core, 'startGroup');
      sinon.stub(core, 'endGroup');
      sinon.stub(ActionInput.prototype, '_fetchAllInput');
      sinon.stub(ActionInput.prototype, '_validateInput');

      // Mock required properties
      actionInput = new ActionInput();
      actionInput.username = 'someUsername';
      actionInput.accessKey = 'someAccessKey';
      actionInput.buildName = 'someBuildName';
      actionInput.projectName = 'someProjectName';
      // _fetchAllInput is stubbed out above, so these flags have to be set by hand.
      actionInput.buildNameProvided = true;
      actionInput.projectNameProvided = true;

      // Stub checkIfBStackReRun to return true
      sinon.stub(actionInput, 'checkIfBStackReRun').returns(Promise.resolve(true));
    });

    afterEach(() => {
      sinon.restore();
    });

    it('Sets the environment variables required in test scripts for BrowserStack', () => {
      actionInput.setEnvVariables();
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_USERNAME, 'someUsername');
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_ACCESS_KEY, 'someAccessKey');
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_PROJECT_NAME, 'someProjectName');
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_BUILD_NAME, 'someBuildName');
    });

    it('Does not export BROWSERSTACK_PROJECT_NAME when no project-name input was given', () => {
      actionInput.projectNameProvided = false;
      actionInput.setEnvVariables();
      sinon.assert.neverCalledWith(
        core.exportVariable, ENV_VARS.BROWSERSTACK_PROJECT_NAME, sinon.match.any,
      );
      // the other variables are unaffected
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_BUILD_NAME, 'someBuildName');
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_USERNAME, 'someUsername');
    });

    it('Does not export BROWSERSTACK_BUILD_NAME when no build-name input was given', () => {
      actionInput.buildNameProvided = false;
      actionInput.setEnvVariables();
      sinon.assert.neverCalledWith(
        core.exportVariable, ENV_VARS.BROWSERSTACK_BUILD_NAME, sinon.match.any,
      );
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_PROJECT_NAME, 'someProjectName');
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_ACCESS_KEY, 'someAccessKey');
    });

    it('Exports neither name when neither input was given, leaving the user config to win', () => {
      actionInput.buildNameProvided = false;
      actionInput.projectNameProvided = false;
      actionInput.setEnvVariables();
      sinon.assert.neverCalledWith(
        core.exportVariable, ENV_VARS.BROWSERSTACK_BUILD_NAME, sinon.match.any,
      );
      sinon.assert.neverCalledWith(
        core.exportVariable, ENV_VARS.BROWSERSTACK_PROJECT_NAME, sinon.match.any,
      );
    });

    it('Calls setBStackRerunEnvVars when checkIfBStackReRun returns true', async () => {
      const setBStackRerunEnvVarsStub = sinon.stub(actionInput, 'setBStackRerunEnvVars').resolves();
      await actionInput.setEnvVariables();
      sinon.assert.calledOnce(setBStackRerunEnvVarsStub);
    });
  });

  context('Check if BrowserStack Rerun', () => {
    let stubbedInput;

    beforeEach(() => {
      stubbedInput = sinon.stub(core, 'getInput');
      sinon.stub(InputValidator, 'updateUsername').returns('validatedUsername');
      sinon.stub(InputValidator, 'validateBuildName').returns('validatedBuildName');
      sinon.stub(InputValidator, 'validateProjectName').returns('validatedProjectName');
      sinon.stub(InputValidator, 'validateGithubAppName').returns('validatedAppName');
      sinon.stub(InputValidator, 'validateGithubToken').returns('validatedToken');

      // Provide required inputs
      stubbedInput.withArgs(INPUT.USERNAME, { required: true }).returns('someUsername');
      stubbedInput.withArgs(INPUT.ACCESS_KEY, { required: true }).returns('someAccessKey');

      process.env.GITHUB_REPOSITORY = 'browserstack/github-actions';
      process.env.GITHUB_RUN_ID = '12345';
      process.env.GITHUB_RUN_ATTEMPT = '2';
    });

    afterEach(() => {
      sinon.restore();
    });

    it('Returns false if rerun attempt is less than or equal to 1', async () => {
      const actionInput = new ActionInput();
      actionInput.rerunAttempt = '1'; // This should be a string or number
      const result = await actionInput.checkIfBStackReRun();
      // eslint-disable-next-line no-unused-expressions
      expect(result).to.be.false;
    });

    it('Returns false if runId, repository, or token are invalid', async () => {
      const actionInput = new ActionInput();
      actionInput.runId = '';
      const result = await actionInput.checkIfBStackReRun();
      // eslint-disable-next-line no-unused-expressions
      expect(result).to.be.false;
    });

    it('Returns true if rerun was triggered by the GitHub App', async () => {
      const actionInput = new ActionInput();
      process.env.GITHUB_TRIGGERING_ACTOR = 'validatedAppName';
      const result = await actionInput.checkIfBStackReRun();
      // eslint-disable-next-line no-unused-expressions
      expect(result).to.be.true;
      delete process.env.GITHUB_TRIGGERING_ACTOR;
    });

    it('Returns false if rerun was not triggered by the GitHub App', async () => {
      const actionInput = new ActionInput();
      process.env.GITHUB_TRIGGERING_ACTOR = 'otherActor';
      const result = await actionInput.checkIfBStackReRun();
      // eslint-disable-next-line no-unused-expressions
      expect(result).to.be.false;
      delete process.env.GITHUB_TRIGGERING_ACTOR;
    });
  });

  context('Set BrowserStack Rerun Environment Variables', () => {
    let axiosGetStub;
    let stubbedInput;

    beforeEach(() => {
      stubbedInput = sinon.stub(core, 'getInput');
      sinon.stub(InputValidator, 'updateUsername').returns('validatedUsername');
      sinon.stub(InputValidator, 'validateBuildName').returns('validatedBuildName');
      sinon.stub(InputValidator, 'validateProjectName').returns('validatedProjectName');
      sinon.stub(InputValidator, 'validateGithubAppName').returns('validatedAppName');
      sinon.stub(InputValidator, 'validateGithubToken').returns('validatedToken');

      // Provide required inputs
      stubbedInput.withArgs(INPUT.USERNAME, { required: true }).returns('someUsername');
      stubbedInput.withArgs(INPUT.ACCESS_KEY, { required: true }).returns('someAccessKey');

      process.env.GITHUB_REPOSITORY = 'browserstack/github-actions';
      process.env.GITHUB_RUN_ID = '12345';
      process.env.GITHUB_RUN_ATTEMPT = '2';

      // Stub the axios.get method
      axiosGetStub = sinon.stub(axios, 'get');
      // Stub core.info to prevent it from throwing an error
      sinon.stub(core, 'exportVariable');
      sinon.stub(core, 'info');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('Sets environment variables from BrowserStack API response (allowlisted only)', async () => {
      const actionInput = new ActionInput();
      const variables = {
        BROWSERSTACK_RERUN: 'true',
        BROWSERSTACK_RERUN_TESTS: 'spec1.js,spec2.js',
        BROWSERSTACK_BUILD_NAME: 'rerun-build-1',
      };
      axiosGetStub.resolves({
        data: { data: { variables } },
      });

      await actionInput.setBStackRerunEnvVars();

      sinon.assert.calledWith(core.exportVariable, 'BROWSERSTACK_RERUN', 'true');
      sinon.assert.calledWith(core.exportVariable, 'BROWSERSTACK_RERUN_TESTS', 'spec1.js,spec2.js');
      sinon.assert.calledWith(core.exportVariable, 'BROWSERSTACK_BUILD_NAME', 'rerun-build-1');
    });

    it('Rejects non-allowlisted env vars from BrowserStack API response (APS-19076)', async () => {
      // Security regression: a malicious or compromised BrowserStack rerun
      // API response must not be able to inject arbitrary env vars into the
      // workflow runner (e.g. NODE_OPTIONS, PATH, GITHUB_TOKEN overrides).
      const coreWarningStub = sinon.stub(core, 'warning');
      const actionInput = new ActionInput();
      const variables = {
        BROWSERSTACK_RERUN: 'true',
        NODE_OPTIONS: '--require /tmp/evil.js',
        PATH: '/tmp/evil:/usr/bin',
        GITHUB_TOKEN: 'attacker-controlled',
      };
      axiosGetStub.resolves({
        data: { data: { variables } },
      });

      await actionInput.setBStackRerunEnvVars();

      sinon.assert.calledWith(core.exportVariable, 'BROWSERSTACK_RERUN', 'true');
      sinon.assert.neverCalledWith(core.exportVariable, 'NODE_OPTIONS', sinon.match.any);
      sinon.assert.neverCalledWith(core.exportVariable, 'PATH', sinon.match.any);
      sinon.assert.neverCalledWith(core.exportVariable, 'GITHUB_TOKEN', sinon.match.any);
      sinon.assert.calledWith(coreWarningStub, sinon.match(/NODE_OPTIONS/));
      sinon.assert.calledWith(coreWarningStub, sinon.match(/PATH/));
      sinon.assert.calledWith(coreWarningStub, sinon.match(/GITHUB_TOKEN/));
    });

    it('Handles errors when BrowserStack API fails', async () => {
      const actionInput = new ActionInput();
      axiosGetStub.rejects(new Error('API failed'));

      await actionInput.setBStackRerunEnvVars();

      sinon.assert.calledTwice(core.info);
      sinon.assert.neverCalledWith(core.exportVariable, sinon.match.any, sinon.match.any);
    });
  });
});
