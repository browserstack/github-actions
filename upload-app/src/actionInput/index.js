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
      this.app_url = core.getInput(INPUT.APP_URL);
      this.test_suite_url = core.getInput(INPUT.TEST_SUITE_URL);
      this.test_suite_path = core.getInput(INPUT.TEST_SUITE);
      this.app_custom_id = core.getInput(INPUT.APP_CUSTOM_ID);
      this.test_suite_custom_id = core.getInput(INPUT.TEST_SUITE_CUSTOM_ID);
    } catch (e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  _validateInput() {
    if (!this.username) throw Error(`${ENV_VARS.BROWSERSTACK_USERNAME} not found. Use 'browserstack/github-actions/setup-env@master' Action to set up the environment variables before invoking this Action`);
    if (!this.accessKey) throw Error(`${ENV_VARS.BROWSERSTACK_ACCESS_KEY} not found. Use 'browserstack/github-actions/setup-env@master' Action to set up the environment variables before invoking this Action`);

    const isTestSuitePassed = this.test_suite_path || this.test_suite_url;
    const isAppPassed = this.app_path || this.app_url;

    if (!isTestSuitePassed && !isAppPassed) {
      throw Error(`Action needs at least one of app or test suite passed as file or url`);
    }

    if (isTestSuitePassed && !this.framework) {
      throw Error(`For using ${INPUT.TEST_SUITE} you must define the ${INPUT.FRAMEWORK}`);
    }

    if (this.app_path && !fs.existsSync(this.app_path)) {
      throw Error(`App specified in ${INPUT.APP_PATH} doesn't exist`);
    }

    if (this.test_suite_path && !fs.existsSync(this.test_suite_path)) {
      throw Error(`TestSuite specified in ${INPUT.TEST_SUITE} doesn't exist`);
    }

    if (this.framework && !Object.keys(URLS.APP_FRAMEWORKS).includes(this.framework)) {
      throw Error(`Action doesn't support the specified framework ${this.framework}`);
    }

    if (this.app_custom_id && !isAppPassed) {
      throw Error(`${INPUT.APP_CUSTOM_ID} works only if either of ${INPUT.APP_URL}/${INPUT.APP_PATH} is defined`);
    }

    if (this.test_suite_custom_id && !isTestSuitePassed) {
      throw Error(`${INPUT.TEST_SUITE_CUSTOM_ID} works only if either of ${INPUT.TEST_SUITE_URL}/${INPUT.test_suite_path} is defined`);
    }
  }

  setEnvVariables() {
    if (this.framework) core.exportVariable(ENV_VARS.FRAMEWORK, this.framework);
  }
}

module.exports = ActionInput;
