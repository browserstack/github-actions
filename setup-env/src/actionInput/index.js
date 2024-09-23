const core = require('@actions/core');
const axios = require('axios');
const github = require('@actions/github');
const InputValidator = require('./inputValidator');
const constants = require('../../config/constants');
const { BROWSERSTACK_TEMPLATE } = require("../../config/constants");

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
      this.githubToken = core.getInput(INPUT.GITHUB_TOKEN);
      this.githubApp = core.getInput(INPUT.GITHUB_APP);
      this.rerunAttempt = process?.env?.GITHUB_RUN_ATTEMPT;
      this.runId = process?.env?.GITHUB_RUN_ID;
      this.repository = `${github?.context?.repo?.owner}/${github?.context?.repo?.repo}`;
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
    this.githubToken = InputValidator.validateGithubToken(this.githubToken);
    this.githubApp = InputValidator.validateGithubAppName(this.githubApp);
  }

  /**
   * Sets env variables to be used in the test script for BrowserStack
   */
  async setEnvVariables() {
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

    if (await this.checkIfBStackReRun()) {
      await this.setBStackRerunEnvVars();
    }
    core.endGroup();
  }

  async checkIfBStackReRun() {
    // Using !! ensures that the function returns true or false, regardless of the input values.
    if (!this.rerunAttempt || !this.rerunAttempt > 1) {
      return false;
    }
    if (!this.runId || !this.runId > 1 || !this.repository || this.repository === 'none'
      || !this.githubToken || this.githubToken === 'none' || !this.username || !this.accessKey) {
      return false;
    }
    const triggeringActor = await this.identifyRunFromBStack();
    core.info(`Triggering actor is - ${triggeringActor}`);
    return triggeringActor === this.githubApp;
  }

  async identifyRunFromBStack() {
    try {
      const runDetailsUrl = `https://api.github.com/repos/${this.repository}/actions/runs/${this.runId}`;
      const runDetailsResponse = await axios.get(runDetailsUrl, {
        headers: {
          Authorization: `token ${this.githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      return runDetailsResponse.data.triggering_actor?.login;
    } catch (error) {
      core.info(`Error getting run details to identify actor of the build: ${error.message}`);
    }
  }

  async setBStackRerunEnvVars() {
    try {
      // Check if the run was triggered by the BrowserStack rerun bot
      core.info('The re-run was triggered by the GitHub App from BrowserStack.');

      const browserStackApiUrl = BROWSERSTACK_TEMPLATE.DETAILS_API_URL.replace('{runId}', this.runId);

      // Call BrowserStack API to get the tests to rerun
      const bsApiResponse = await axios.get(browserStackApiUrl, {
        auth: {
          username: this.username.replace("-GitHubAction", ""),
          password: this.accessKey,
        },
        headers: {
          'Content-Type': 'application/json',
          'x-rs-auth': true,
        },
      });
      const variables = bsApiResponse?.data?.data?.variables;
      if (variables && typeof variables === 'object') {
        Object.keys(variables).forEach((key) => {
          core.exportVariable(key, variables[key]);
        });
      }
    } catch (error) {
      core.info(`Error setting BrowserStack rerun environment variables: ${error.message}`);
    }
  }
}

module.exports = ActionInput;
