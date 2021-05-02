const { expect } = require('chai');
const sinon = require('sinon');
const core = require('@actions/core');
const fs = require('fs');
const constants = require('../../config/constants');
const ActionInput = require('../../src/actionInput');

const {
  INPUT,
  ENV_VARS,
} = constants;

describe('Action Input operations for fetching all inputs, triggering validation and setting env vars', () => {
  let stubbedInput;
  let stubbedExists;
  let previousAccessKey;
  let previousLocalIdentifier;

  beforeEach(() => {
    previousAccessKey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
    previousLocalIdentifier = process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER];
    process.env[ENV_VARS.BROWSERSTACK_USERNAME] = "some_user_name";
    process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = "some_access_key";
    stubbedInput = sinon.stub(core, 'getInput');
    stubbedInput.withArgs(INPUT.FRAMEWORK).returns("espresso");
    stubbedInput.withArgs(INPUT.CONFIG_PATH).returns("some/random/config.json");
    stubbedExists = sinon.stub(fs, 'existsSync');
    stubbedExists.withArgs("some/random/config.json").returns(true);
  });

  afterEach(() => {
    process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = previousAccessKey;
    process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER] = previousLocalIdentifier;
    core.getInput.restore();
    fs.existsSync.restore();
  });

  context('Fetch and Validate Input', () => {
    it('should read values from input and validate them', () => {
      const actionInput = new ActionInput();
      expect(actionInput.config_path).to.equal("some/random/config.json");
      expect(actionInput.framework).to.equal("espresso");
      expect(actionInput.username).to.equal("some_user_name");
      expect(actionInput.accessKey).to.equal("some_access_key");
    });

    it('should give error message in case config path specified does not exist', () => {
      stubbedExists.withArgs("some/random/config.json").returns(false);
      expect(() => new ActionInput()).to.throw("Action input failed for reason: some/random/config.json doesn't exists make sure that path provided does exists");
    });

    it('should give error message in case framework is not specified', () => {
      stubbedInput.withArgs(INPUT.FRAMEWORK).returns("");
      expect(() => new ActionInput()).to.throw("Action input failed for reason: framework input isn't provided, you must specify the framework key in action input");
    });
  });
});
