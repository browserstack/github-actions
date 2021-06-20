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
    stubbedInput.withArgs(INPUT.APP_PATH).returns("some/random/app/path.apk");
    stubbedInput.withArgs(INPUT.FRAMEWORK).returns("espresso");
    stubbedInput.withArgs(INPUT.TEST_SUITE).returns("some/random/test/path.apk");
    stubbedExists = sinon.stub(fs, 'existsSync');
    stubbedExists.withArgs("some/random/app/path.apk").returns(true);
    stubbedExists.withArgs("some/random/test/path.apk").returns(true);
    sinon.stub(core, 'exportVariable');
  });

  afterEach(() => {
    process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = previousAccessKey;
    process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER] = previousLocalIdentifier;
    core.getInput.restore();
    fs.existsSync.restore();
    core.exportVariable.restore();
  });

  context('Fetch and Validate Input', () => {
    it('should read values from input and validate them', () => {
      const actionInput = new ActionInput();
      expect(actionInput.app_path).to.equal("some/random/app/path.apk");
      expect(actionInput.test_suite_path).to.equal("some/random/test/path.apk");
      expect(actionInput.framework).to.equal("espresso");
      expect(actionInput.username).to.equal("some_user_name");
      expect(actionInput.accessKey).to.equal("some_access_key");
    });

    it('should give error message in case app path specified does not exist', () => {
      stubbedExists.withArgs("some/random/app/path.apk").returns(false);
      expect(() => new ActionInput()).to.throw("App specified in app-path doesn't exist");
    });

    it('should give error message in case framework is not specified but test suite is passed', () => {
      stubbedInput.withArgs(INPUT.FRAMEWORK).returns("");
      expect(() => new ActionInput()).to.throw("For using test-suite-path you must define the framework");
    });

    it('should give error message in case framework passed is not supported', () => {
      stubbedInput.withArgs(INPUT.FRAMEWORK).returns("random_framework");
      expect(() => new ActionInput()).to.throw("Action doesn't support the specified framework random_framework");
    });

    it('should give error message in case neither app nor test suite passed is not supported', () => {
      stubbedInput.withArgs(INPUT.APP_PATH).returns(undefined);
      stubbedInput.withArgs(INPUT.TEST_SUITE).returns(undefined);
      expect(() => new ActionInput()).to.throw("Action needs at least one of app or test suite passed as file or url");
    });

    it('should not give error message in app-url is passed and not app-path', () => {
      stubbedInput.withArgs(INPUT.APP_PATH).returns(undefined);
      stubbedInput.withArgs(INPUT.TEST_SUITE).returns(undefined);
      stubbedInput.withArgs(INPUT.APP_URL).returns("http://something.com");
      const actionInput = new ActionInput();
      expect(actionInput.app_url).to.equal("http://something.com");
    });

    it('should not give error message in test-suite-url is passed and not test-suite-path', () => {
      stubbedInput.withArgs(INPUT.APP_PATH).returns(undefined);
      stubbedInput.withArgs(INPUT.TEST_SUITE).returns(undefined);
      stubbedInput.withArgs(INPUT.TEST_SUITE_URL).returns("http://something.com");
      const actionInput = new ActionInput();
      expect(actionInput.test_suite_url).to.equal("http://something.com");
    });
  });

  describe('setEnvVariables', () => {
    it('should framework to environment variable', () => {
      const actionInput = new ActionInput();
      actionInput.setEnvVariables();
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.FRAMEWORK, 'espresso');
    });
  });
});
