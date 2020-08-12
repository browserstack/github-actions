const core = require('@actions/core');
const InputValidator = require('./inputValidator');
const constants = require('../../config/constants');

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
      // required field
      this.localTesting = core.getInput(INPUT.LOCAL_TESING, { required: true });
      this.accessKey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];

      if (!this.accessKey) throw Error(`${ENV_VARS.BROWSERSTACK_ACCESS_KEY} not found`);

      // non-compulsory fields
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

    if (this.localTesting === LOCAL_TESTING.START) {
      this.localLoggingLevel = InputValidator.validateLocalLoggingLevel(this.localLoggingLevel);
      this.localIdentifier = InputValidator.validateLocalIdentifier(this.localIdentifier);
      this.localArgs = InputValidator.validateLocalArgs(this.localArgs);
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

module.exports = ActionInput;
