import * as core from '@actions/core';
import InputValidator from './inputValidator';
import constants from '../../config/constants';

const {
  INPUT,
  ENV_VARS,
  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING,
  },
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
      this.localTesting = core.getInput(INPUT.LOCAL_TESING);
      this.localLoggingLevel = core.getInput(INPUT.LOCAL_LOGGING_LEVEL);
      this.localIdentifier = core.getInput(INPUT.LOCAL_IDENTIFIER);
      this.localArgs = core.getInput(INPUT.LOCAL_ARGS);
    } catch (e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  /**
   * Sets env variables to be used in the test script for BrowserStack
   */
  setEnvVariables() {
    core.startGroup('Setting Environment Variables');

    core.exportVariable(ENV_VARS.BROWSERSTACK_USERNAME, this.username);
    core.exportVariable(ENV_VARS.BROWSERSTACK_ACCESS_KEY, this.accessKey);

    core.exportVariable(ENV_VARS.BROWSERSTACK_PROJECT_NAME, this.projectName);
    core.info(`${ENV_VARS.BROWSERSTACK_PROJECT_NAME} environment variable set as: ${this.projectName}`);
    core.info(`Use ${ENV_VARS.BROWSERSTACK_PROJECT_NAME} environment variable for your project name capability in your tests\n`);

    core.exportVariable(ENV_VARS.BROWSERSTACK_BUILD_NAME, this.buildName);
    core.info(`${ENV_VARS.BROWSERSTACK_BUILD_NAME} environment variable set as: ${this.buildName}`);
    core.info(`Use ${ENV_VARS.BROWSERSTACK_BUILD_NAME} environment variable for your build name capability in your tests\n`);

    if ((this.localTesting === LOCAL_TESTING.START) && this.localIdentifier) {
      core.exportVariable(ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER, this.localIdentifier);
      core.info(`${ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER} environment variable set as: ${this.localIdentifier}`);
      core.info(`Use ${ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER} env variable in your test script as the local identifier\n`);
    }

    core.endGroup();
  }

  /**
   * Triggers conditional validation of action input values based on the operation
   * to be performed, i.e. start/no local connection required, stopping of local connection
   */
  _validateInput() {
    this.localTesting = InputValidator.validateLocalTesting(this.localTesting);

    if ([LOCAL_TESTING.START, LOCAL_TESTING.FALSE].includes(this.localTesting)) {
      // properties common to local/non-local testing comes here
      this.username = InputValidator.validateUsername(this.username);
      this.projectName = InputValidator.validateProjectName(this.projectName);
      this.buildName = InputValidator.validateBuildName(this.buildName);

      // properties specific to requiring local testing shall come in this block
      if (this.localTesting === LOCAL_TESTING.START) {
        this.localLoggingLevel = InputValidator.validateLocalLoggingLevel(this.localLoggingLevel);
        this.localIdentifier = InputValidator.validateLocalIdentifier(this.localIdentifier);
        this.localArgs = InputValidator.validateLocalArgs(this.localArgs);
      }
    } else {
      this.localIdentifier = process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER];
    }
  }

  /**
   * Returns the information required for setting up of Local Binary
   * @returns {{
   *  accessKey: String,
   *  localTesting: String,
   *  localArgs: String,
   *  localIdentifier: String,
   *  localLoggingLevel: Number
   * }}
   */
  getInputStateForBinary() {
    return {
      accessKey: this.accessKey,
      localTesting: this.localTesting,
      localArgs: this.localArgs,
      localIdentifier: this.localIdentifier,
      localLoggingLevel: this.localLoggingLevel,
    };
  }
}

export default ActionInput;
