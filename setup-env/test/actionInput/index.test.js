const { expect } = require('chai');
const sinon = require('sinon');
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
      sinon.stub(InputValidator, 'validateUsername').returns('validatedUsername');
      sinon.stub(InputValidator, 'validateBuildName').returns('validatedBuildName');
      sinon.stub(InputValidator, 'validateProjectName').returns('validatedProjectName');
    });

    afterEach(() => {
      core.getInput.restore();
      InputValidator.validateUsername.restore();
      InputValidator.validateBuildName.restore();
      InputValidator.validateProjectName.restore();
    });

    it('Takes input and validates it successfully', () => {
      stubbedInput.withArgs(INPUT.USERNAME, { required: true }).returns('someUsername');
      stubbedInput.withArgs(INPUT.ACCESS_KEY, { required: true }).returns('someAccessKey');
      stubbedInput.withArgs(INPUT.BUILD_NAME).returns('someBuildName');
      stubbedInput.withArgs(INPUT.PROJECT_NAME).returns('someProjectName');
      const actionInput = new ActionInput();
      sinon.assert.calledWith(core.getInput, INPUT.USERNAME, { required: true });
      sinon.assert.calledWith(core.getInput, INPUT.ACCESS_KEY, { required: true });
      sinon.assert.calledWith(core.getInput, INPUT.BUILD_NAME);
      sinon.assert.calledWith(core.getInput, INPUT.PROJECT_NAME);
      sinon.assert.calledWith(InputValidator.validateUsername, 'someUsername');
      sinon.assert.calledWith(InputValidator.validateBuildName, 'someBuildName');
      sinon.assert.calledWith(InputValidator.validateProjectName, 'someProjectName');
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
      sinon.assert.notCalled(InputValidator.validateUsername);
      sinon.assert.notCalled(InputValidator.validateBuildName);
      sinon.assert.notCalled(InputValidator.validateProjectName);
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
      core.exportVariable.restore();
      core.info.restore();
      core.startGroup.restore();
      core.endGroup.restore();
      ActionInput.prototype._fetchAllInput.restore();
      ActionInput.prototype._validateInput.restore();
    });

    it('Sets the environment variables required to in test scripts for BrowserStack', () => {
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
});
