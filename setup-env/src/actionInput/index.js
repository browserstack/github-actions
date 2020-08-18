const core = require('@actions/core');
const InputValidator = require('./inputValidator');
const constants = require('../../config/constants');

const {
  INPUT,
  ENV_VARS,
} = constants;

/**
 * ActionInput manages the fetching of action input values and
 * helps in setting env variables post validation.
 */
class ActionInput {
  constructor() {
    this._fetchAllInput();
    this._validateInput();
  }

  /**
   * Fetches all the input values given to the action.
   * Raises error if the required values are not provided.
   */
  _fetchAllInput() {
    try {
      // required fields
      this.username = core.getInput(INPUT.USERNAME, { required: true });
      this.accessKey = core.getInput(INPUT.ACCESS_KEY, { required: true });

      // non-compulsory fields
      this.buildName = core.getInput(INPUT.BUILD_NAME);
      this.projectName = core.getInput(INPUT.PROJECT_NAME);
    } catch (e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  /**
   * Validates the input values
   */
  _validateInput() {
    this.username = InputValidator.updateUsername(this.username);
    this.buildName = InputValidator.validateBuildName(this.buildName);
    this.projectName = InputValidator.validateProjectName(this.projectName);
  }

  /**
   * Sets env variables to be used in the test script for BrowserStack
   */
  setEnvVariables() {
    core.startGroup('Setting Environment Variables');

    core.exportVariable(ENV_VARS.BROWSERSTACK_USERNAME, this.username);
    core.info(`Use ${ENV_VARS.BROWSERSTACK_USERNAME} environment variable for your username in your tests\n`);

    core.exportVariable(ENV_VARS.BROWSERSTACK_ACCESS_KEY, this.accessKey);
    core.info(`Use ${ENV_VARS.BROWSERSTACK_ACCESS_KEY} environment variable for your access key in your tests\n`);

    core.exportVariable(ENV_VARS.BROWSERSTACK_PROJECT_NAME, this.projectName);
    core.info(`${ENV_VARS.BROWSERSTACK_PROJECT_NAME} environment variable set as: ${this.projectName}`);
    core.info(`Use ${ENV_VARS.BROWSERSTACK_PROJECT_NAME} environment variable for your project name capability in your tests\n`);

    core.exportVariable(ENV_VARS.BROWSERSTACK_BUILD_NAME, this.buildName);
    core.info(`${ENV_VARS.BROWSERSTACK_BUILD_NAME} environment variable set as: ${this.buildName}`);
    core.info(`Use ${ENV_VARS.BROWSERSTACK_BUILD_NAME} environment variable for your build name capability in your tests\n`);

    core.endGroup();
  }
}

module.exports = ActionInput;
