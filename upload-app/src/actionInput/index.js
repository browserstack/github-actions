const core = require('@actions/core');
const constants = require('../../config/constants');

const {
  ENV_VARS,
  INPUT,
} = constants;

class ActionInput {
  constructor() {
    this._fetchAllInput();
    this._validateInput();
  }

  _fetchAllInput() {
    try {
      this.username = process.env[ENV_VARS.BROWSERSTACK_USERNAME];
      this.accesskey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
      this.app_path = core.getInput(INPUT.APP_PATH);
      this.framework = core.getInput(INPUT.FRAMEWORK);
      this.test_suite_path = core.getInput(INPUT.TEST_SUITE);
    } catch (e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  _validateInput() {
    if (this.test_suite_path && !this.framework) {
      throw Error(`for using ${INPUT.TEST_SUITE} you must define the ${INPUT.FRAMEWORK}`);
    }
  }

  setEnvVariables() {
    if (this.framework) core.exportVariable(ENV_VARS.FRAMEWORK, this.framework);
  }
}

module.exports = ActionInput;
