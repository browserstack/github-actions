const core = require('@actions/core');
const fs = require('fs');
const constants = require('../../config/constants');

const {
  ENV_VARS,
  INPUT,
  URLS,
} = constants;

class ActionInput {
  constructor() {
    this._fetchAllInput();
    this._validateInput();
  }

  _fetchAllInput() {
    try {
      this.username = process.env[ENV_VARS.BROWSERSTACK_USERNAME];
      this.accessKey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
      this.app_path = core.getInput(INPUT.APP_PATH);
      this.framework = core.getInput(INPUT.FRAMEWORK);
      this.test_suite_path = core.getInput(INPUT.TEST_SUITE);
    } catch (e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  _validateInput() {
    if (!this.username) throw Error(`${ENV_VARS.BROWSERSTACK_USERNAME} not found. Use 'browserstack/github-actions/setup-env@master' Action to set up the environment variables before invoking this Action`);
    if (!this.accessKey) throw Error(`${ENV_VARS.BROWSERSTACK_ACCESS_KEY} not found. Use 'browserstack/github-actions/setup-env@master' Action to set up the environment variables before invoking this Action`);

    if (this.test_suite_path && !this.framework) {
      throw Error(`For using ${INPUT.TEST_SUITE} you must define the ${INPUT.FRAMEWORK}`);
    }
    if (!fs.existsSync(this.app_path)) {
      throw Error(`App specified in ${INPUT.APP_PATH} doesn't exist`);
    }
    if (!fs.existsSync(this.test_suite_path)) {
      throw Error(`TestSuite specified in ${INPUT.TEST_SUITE} doesn't exist`);
    }
    if (this.framework && !Object.keys(URLS.FRAMEWORKS).includes(this.framework)) {
      throw Error(`Action doesn't support the specified framework ${this.framework}`);
    }
  }

  setEnvVariables() {
    if (this.framework) core.exportVariable(ENV_VARS.FRAMEWORK, this.framework);
  }
}

module.exports = ActionInput;
