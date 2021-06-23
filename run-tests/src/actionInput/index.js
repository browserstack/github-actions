const core = require('@actions/core');
const fs = require('fs');
const constants = require("../../config/constants");

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
      this.accessKey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
      this.config_path = core.getInput(INPUT.CONFIG_PATH);
      this.framework = core.getInput(INPUT.FRAMEWORK);
    } catch (e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  _validateInput() {
    if (!this.username) throw Error(`${ENV_VARS.BROWSERSTACK_USERNAME} not found. Use 'browserstack/github-actions/setup-env@master' Action to set up the environment variables before invoking this Action`);
    if (!this.accessKey) throw Error(`${ENV_VARS.BROWSERSTACK_ACCESS_KEY} not found. Use 'browserstack/github-actions/setup-env@master' Action to set up the environment variables before invoking this Action`);

    if (!fs.existsSync(this.config_path)) {
      throw Error(`Action input failed for reason: ${this.config_path} doesn't exists make sure that path provided does exists`);
    }
    if (!process.env[ENV_VARS.FRAMEWORK]) {
      if (!this.framework) {
        throw Error(`Action input failed for reason: framework input isn't provided, you must specify the framework key in action input`);
      }
    }
  }
}

module.exports = ActionInput;
