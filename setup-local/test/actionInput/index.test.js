const { expect } = require('chai');
const sinon = require('sinon');
const core = require('@actions/core');
const ActionInput = require('../../src/actionInput');
const InputValidator = require('../../src/actionInput/inputValidator');
const constants = require('../../config/constants');

const {
  INPUT,
  ENV_VARS,
  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING,
  },
} = constants;

describe('Action Input operations for fetching all inputs, triggering validation and setting env vars', () => {
  context('Fetch and Validate Input', () => {
    let stubbedInput;
    let previousAccessKey;
    let previousLocalIdentifier;

    beforeEach(() => {
      previousAccessKey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
      previousLocalIdentifier = process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER];
      stubbedInput = sinon.stub(core, 'getInput');
      stubbedInput.withArgs(INPUT.LOCAL_LOGGING_LEVEL).returns('someLevel');
      stubbedInput.withArgs(INPUT.LOCAL_IDENTIFIER).returns('someIdentifier');
      stubbedInput.withArgs(INPUT.LOCAL_ARGS).returns('someArgs');
      sinon.stub(InputValidator, 'validateLocalLoggingLevel').returns('validatedLoggingLevel');
      sinon.stub(InputValidator, 'validateLocalIdentifier').returns('validatedLocalIdentifier');
      sinon.stub(InputValidator, 'validateLocalArgs').returns('validatedLocalArgs');
    });

    afterEach(() => {
      process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = previousAccessKey;
      process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER] = previousLocalIdentifier;
      core.getInput.restore();
      InputValidator.validateLocalLoggingLevel.restore();
      InputValidator.validateLocalIdentifier.restore();
      InputValidator.validateLocalArgs.restore();
    });

    it('Takes input and validates it successfully for start operation', () => {
      sinon.stub(InputValidator, 'validateLocalTesting').returns('start');
      process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = 'someAccessKey';
      stubbedInput.withArgs(INPUT.LOCAL_TESING, { required: true }).returns('start');
      const actionInput = new ActionInput();
      sinon.assert.calledWith(core.getInput, INPUT.LOCAL_TESING, { required: true });
      sinon.assert.calledWith(core.getInput, INPUT.LOCAL_LOGGING_LEVEL);
      sinon.assert.calledWith(core.getInput, INPUT.LOCAL_IDENTIFIER);
      sinon.assert.calledWith(core.getInput, INPUT.LOCAL_ARGS);
      sinon.assert.calledWith(InputValidator.validateLocalTesting, 'start');
      sinon.assert.calledWith(InputValidator.validateLocalLoggingLevel, 'someLevel');
      sinon.assert.calledWith(InputValidator.validateLocalIdentifier, 'someIdentifier');
      sinon.assert.calledWith(InputValidator.validateLocalArgs, 'someArgs');
      expect(actionInput.localTesting).to.eq('start');
      expect(actionInput.localLoggingLevel).to.eq('validatedLoggingLevel');
      expect(actionInput.localIdentifier).to.eq('validatedLocalIdentifier');
      expect(actionInput.localArgs).to.eq('validatedLocalArgs');
      InputValidator.validateLocalTesting.restore();
    });

    it('Takes input and validates it successfully for stop operation', () => {
      sinon.stub(InputValidator, 'validateLocalTesting').returns('stop');
      process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = 'someAccessKey';
      process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER] = 'alreadyExistingIdentifier';
      stubbedInput.withArgs(INPUT.LOCAL_TESING, { required: true }).returns('start');
      const actionInput = new ActionInput();
      sinon.assert.calledWith(core.getInput, INPUT.LOCAL_TESING, { required: true });
      sinon.assert.calledWith(core.getInput, INPUT.LOCAL_LOGGING_LEVEL);
      sinon.assert.calledWith(core.getInput, INPUT.LOCAL_IDENTIFIER);
      sinon.assert.calledWith(core.getInput, INPUT.LOCAL_ARGS);
      sinon.assert.calledWith(InputValidator.validateLocalTesting, 'start');
      sinon.assert.notCalled(InputValidator.validateLocalLoggingLevel);
      sinon.assert.notCalled(InputValidator.validateLocalIdentifier);
      sinon.assert.notCalled(InputValidator.validateLocalArgs);
      expect(actionInput.localTesting).to.eq('stop');
      expect(actionInput.localIdentifier).to.eq('alreadyExistingIdentifier');
      InputValidator.validateLocalTesting.restore();
    });

    it('Throws error if local-testing input is not provided', () => {
      stubbedInput.withArgs(INPUT.LOCAL_TESING, { required: true }).throws(Error('Local Testing not provided'));
      try {
        // eslint-disable-next-line no-new
        new ActionInput();
      } catch (e) {
        expect(e.message).to.eq('Action input failed for reason: Local Testing not provided');
      }
    });

    it('Throws error if access key is not found from the env vars', () => {
      process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = '';
      try {
        // eslint-disable-next-line no-new
        new ActionInput();
      } catch (e) {
        expect(e.message).to.eq(`Action input failed for reason: ${ENV_VARS.BROWSERSTACK_ACCESS_KEY} not found. Use 'browserstack/github-actions/setup-env@master' Action to set up the environment variables before invoking this Action`);
      }
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

    it('sets the local identifier env variable if the operation is to start the local binary with a local-identifier', () => {
      const actionInput = new ActionInput();
      actionInput.localTesting = LOCAL_TESTING.START;
      actionInput.localIdentifier = 'someIdentifier';
      actionInput.setEnvVariables();
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER, 'someIdentifier');
    });

    it('no local identifier env var is set if no input is provided and the operation is to start the local binary', () => {
      const actionInput = new ActionInput();
      actionInput.localTesting = LOCAL_TESTING.START;
      actionInput.localIdentifier = '';
      actionInput.setEnvVariables();
      sinon.assert.notCalled(core.exportVariable);
    });

    it('no local identifier env var is set if the operation is to stop binary', () => {
      const actionInput = new ActionInput();
      actionInput.localTesting = LOCAL_TESTING.STOP;
      actionInput.setEnvVariables();
      sinon.assert.notCalled(core.exportVariable);
    });
  });

  context('Fetch state for input to binary control', () => {
    it('returns an object with the state', () => {
      sinon.stub(ActionInput.prototype, '_fetchAllInput');
      sinon.stub(ActionInput.prototype, '_validateInput');
      const actionInput = new ActionInput();
      actionInput.accessKey = 'someKey';
      actionInput.localTesting = 'someValue';
      actionInput.localArgs = 'someArgs';
      actionInput.localIdentifier = 'someIdentifier';
      actionInput.localLoggingLevel = 1; // any numeric value

      const response = actionInput.getInputStateForBinary();
      expect(response).to.eql({
        accessKey: 'someKey',
        localTesting: 'someValue',
        localArgs: 'someArgs',
        localIdentifier: 'someIdentifier',
        localLoggingLevel: 1,
      });

      ActionInput.prototype._fetchAllInput.restore();
      ActionInput.prototype._validateInput.restore();
    });
  });
});
