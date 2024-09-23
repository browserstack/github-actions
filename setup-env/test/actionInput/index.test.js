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
      sinon.stub(InputValidator, 'validateGithubToken').returns('validatedToken');
      sinon.stub(InputValidator, 'validateGithubAppName').returns('validatedAppName');

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
    beforeEach(() => {
      sinon.stub(core, 'exportVariable');
      sinon.stub(core, 'info');
      sinon.stub(core, 'startGroup');
      sinon.stub(core, 'endGroup');
      sinon.stub(ActionInput.prototype, '_fetchAllInput');
      sinon.stub(ActionInput.prototype, '_validateInput');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('Sets the environment variables required in test scripts for BrowserStack', () => {
      const actionInput = new ActionInput();
      actionInput.username = 'someUsername';
      actionInput.accessKey = 'someAccessKey';
      actionInput.buildName = 'someBuildName';
      actionInput.projectName = 'someProjectName';
      actionInput.setEnvVariables();
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_USERNAME, 'someUsername');
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_ACCESS_KEY, 'someAccessKey');
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_PROJECT_NAME, 'someProjectName');
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_BUILD_NAME, 'someBuildName');
    });
  });

  context('Check if BrowserStack Rerun', () => {
    let stubbedInput;

    beforeEach(() => {
      stubbedInput = sinon.stub(core, 'getInput');
      sinon.stub(InputValidator, 'updateUsername').returns('validatedUsername');
      sinon.stub(InputValidator, 'validateBuildName').returns('validatedBuildName');
      sinon.stub(InputValidator, 'validateProjectName').returns('validatedProjectName');
      sinon.stub(InputValidator, 'validateGithubToken').returns('validatedToken');
      sinon.stub(InputValidator, 'validateGithubAppName').returns('validatedAppName');

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
      // stubbedInput.withArgs(INPUT.GITHUB_APP).returns('someApp');
      const actionInput = new ActionInput();
      actionInput.rerunAttempt = '1';
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
      sinon.stub(actionInput, 'identifyRunFromBStack').returns(Promise.resolve('validatedAppName'));
      const result = await actionInput.checkIfBStackReRun();
      // eslint-disable-next-line no-unused-expressions
      expect(result).to.be.true;
    });

    it('Returns false if rerun was not triggered by the GitHub App', async () => {
      const actionInput = new ActionInput();
      sinon.stub(actionInput, 'identifyRunFromBStack').returns(Promise.resolve('otherActor'));
      const result = await actionInput.checkIfBStackReRun();
      // eslint-disable-next-line no-unused-expressions
      expect(result).to.be.false;
    });
  });

  context('Identify Run From BrowserStack', () => {
    let axiosGetStub;
    let stubbedInput;

    beforeEach(() => {
      stubbedInput = sinon.stub(core, 'getInput');
      sinon.stub(InputValidator, 'updateUsername').returns('validatedUsername');
      sinon.stub(InputValidator, 'validateBuildName').returns('validatedBuildName');
      sinon.stub(InputValidator, 'validateProjectName').returns('validatedProjectName');
      sinon.stub(InputValidator, 'validateGithubToken').returns('validatedToken');
      sinon.stub(InputValidator, 'validateGithubAppName').returns('validatedAppName');

      // Provide required inputs
      stubbedInput.withArgs(INPUT.USERNAME, { required: true }).returns('someUsername');
      stubbedInput.withArgs(INPUT.ACCESS_KEY, { required: true }).returns('someAccessKey');

      process.env.GITHUB_REPOSITORY = 'browserstack/github-actions';
      process.env.GITHUB_RUN_ID = '12345';
      process.env.GITHUB_RUN_ATTEMPT = '2';

      // Stub the axios.get method
      axiosGetStub = sinon.stub(axios, 'get');
      // Stub core.info to prevent it from throwing an error
      sinon.stub(core, 'info');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('Returns the triggering actor from the GitHub API', async () => {
      const actionInput = new ActionInput();
      axiosGetStub.resolves({
        data: {
          triggering_actor: { login: 'someActor' },
        },
      });
      const result = await actionInput.identifyRunFromBStack();
      expect(result).to.eq('someActor');
    });

    it('Handles errors and returns undefined when GitHub API fails', async () => {
      const actionInput = new ActionInput();
      axiosGetStub.rejects(new Error('API failed'));
      const result = await actionInput.identifyRunFromBStack();
      // eslint-disable-next-line no-unused-expressions
      expect(result).to.be.undefined;
      sinon.assert.calledOnce(core.info);
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
      sinon.stub(InputValidator, 'validateGithubToken').returns('validatedToken');
      sinon.stub(InputValidator, 'validateGithubAppName').returns('validatedAppName');

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

    it('Sets environment variables from BrowserStack API response', async () => {
      const actionInput = new ActionInput();
      const variables = { VAR1: 'value1', VAR2: 'value2' };
      axiosGetStub.resolves({
        data: { data: { variables } },
      });

      await actionInput.setBStackRerunEnvVars();

      sinon.assert.calledWith(core.exportVariable, 'VAR1', 'value1');
      sinon.assert.calledWith(core.exportVariable, 'VAR2', 'value2');
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
