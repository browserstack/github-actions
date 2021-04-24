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
      this.accesskey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
      this.config_path = core.getInput(INPUT.CONFIG_PATH);
    }
    catch(e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  _validateInput() {
  }

  setEnvVariables() {
    if(this.config_path) core.exportVariable(ENV_VARS.CONFIG_PATH, this.app_path);
  }
}

module.exports = ActionInput;
