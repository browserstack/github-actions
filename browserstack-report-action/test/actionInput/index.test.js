const { expect } = require('chai');
const sinon = require('sinon');
const core = require('@actions/core');
const ActionInput = require('../../src/actionInput');
const InputValidator = require('../../src/actionInput/inputValidator');
const constants = require('../../config/constants');

const {
  INPUT,
} = constants;

describe('Action Input operations for fetching all inputs, triggering validation', () => {
  context('Fetch and Validate Input', () => {
    let stubbedInput;

    beforeEach(() => {
      stubbedInput = sinon.stub(core, 'getInput');
      sinon.stub(InputValidator, 'updateUsername').returns('validatedUsername');
      sinon.stub(InputValidator, 'validateBuildName').returns('validatedBuildName');

      // Provide required inputs
      stubbedInput.withArgs(INPUT.USERNAME, { required: true }).returns('someUsername');
      stubbedInput.withArgs(INPUT.ACCESS_KEY, { required: true }).returns('someAccessKey');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('Takes input and validates it successfully', () => {
      stubbedInput.withArgs(INPUT.BUILD_NAME).returns('someBuildName');
      const actionInput = new ActionInput();
      expect(actionInput.username).to.eq('validatedUsername');
      expect(actionInput.buildName).to.eq('validatedBuildName');
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
  });
});
