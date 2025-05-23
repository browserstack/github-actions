const core = require('@actions/core');
const InputValidator = require('./inputValidator');
const { INPUT } = require('../../config/constants');

/**
 * ActionInput manages the fetching of action input values,
 * performs validation, and prepares them for use in the action.
 */
class ActionInput {
  constructor() {
    this._fetchAllInput();
    this._validateInput();
  }

  /**
   * Fetches all the input values provided to the action.
   * Raises error if required values are missing.
   */
  _fetchAllInput() {
    try {
      // Required inputs
      this.username = core.getInput(INPUT.USERNAME, { required: true });
      this.accessKey = core.getInput(INPUT.ACCESS_KEY, { required: true });

      // non-compulsory fields
      this.buildName = core.getInput(INPUT.BUILD_NAME);

      this.userTimeout = core.getInput(INPUT.TIMEOUT);
    } catch (e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  /**
   * Validates and processes the input values.
   */
  _validateInput() {
    // Validate and set build name
    this.buildName = InputValidator.validateBuildName(this.buildName);
    this.username = InputValidator.updateUsername(this.username);

    // Validate user timeout
    this.userTimeout = InputValidator.validateUserTimeout(this.userTimeout);

    // Safety check: Mask the access key in logs
    if (this.accessKey) {
      core.setSecret(this.accessKey);
    }
  }

  /**
   * Returns validated and processed inputs.
   * @returns {Object} The processed inputs
   */
  getInputs() {
    return {
      username: this.username,
      accessKey: this.accessKey,
      buildName: this.buildName,
      userTimeout: this.userTimeout,
    };
  }
}

module.exports = ActionInput;
