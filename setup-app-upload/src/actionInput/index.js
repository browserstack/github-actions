const core = require('@actions/core');
const github = require('@actions/github');
const constants = require('./../constants');


const {
  URLS,
  ENV_VARS,
  INPUT
} = constants;

class ActionInput {
  constructor() {
    this._fetchAllInput();
    this._validateInput();
  }

  _fetchAllInput() {
    try {
      this.username = process.env[ENV_VARS.BROWSERSTACK_USERNAME];
      if (!this.username) throw Error(`${ENV_VARS.BROWSERSTACK_USERNAME} not found. Use 'browserstack/github-actions/setup-app-upload@master' Action to set up the environment variables before invoking this Action`);
      this.accesskey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
      if (!this.accessKey) throw Error(`${ENV_VARS.BROWSERSTACK_ACCESS_KEY} not found. Use 'browserstack/github-actions/setup-app-upload@master' Action to set up the environment variables before invoking this Action`);
      this.app_path = core.getInput(INPUT.APP_PATH);
      this.framework = core.getInput(INPUT.FRAMEWORK);
      this.testsuite_path = core.getInput(INPUT.TEST_SUITE);
    }
    catch(e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  _validateInput() {
    if(this.testsuite_path && !this.framework) {
      throw Error(`for using ${INPUTS.TEST_SUITE} you must define the ${INPUTS.FRAMEWORK}`);
    }
  }

  setEnvVariables() {
    if(this.app_path) core.exportVariable(ENV_VARS.APP_PATH, this.app_path);
    if(this.framework) core.exportVariable(ENV_VARS.FRAMEWORK, this.framework);
    if(this.testsuite_path) core.exportVariable(ENV_VARS.TEST_SUITE, this.testsuite_path);
  }
}

module.exports = ActionInput;
