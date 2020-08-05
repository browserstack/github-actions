import * as core from '@actions/core';
import * as github from '@actions/github';
import constants from '../../config/constants';

const { INPUT, ENV_VARS } = constants;

class ActionInput {
  fetchAllInput() {
    try {
      console.log('check here for github context...');
      console.log(JSON.stringify(github.context));
      
      // required fields
      this.username = core.getInput(INPUT.USERNAME, { required: true });
      this.accessKey = core.getInput(INPUT.ACCESS_KEY, { required: true });

      // non-compulsory fields
      this.buildName = core.getInput(INPUT.BUILD_NAME) || 'some build name';
      this.projectName = core.getInput(INPUT.PROJECT_NAME) || github.context.repo.repo;
      this.localTesting = core.getInput(INPUT.LOCAL_TESING);

      if (this.localTesting) {
        this.localLoggingLevel = core.getInput(INPUT.LOCAL_LOGGING_LEVEL);
        this.localIdentifier = core.getInput(INPUT.LOCAL_IDENTIFIER) || 'some identifier';
        this.localArgs = core.getInput(INPUT.LOCAL_ARGS);
      }

      core.info('CHECK HERE FOR THE INPUT VALS');
      core.info(`username: ${this.username}`);
      core.info(`buildName: ${this.buildName}`);
      core.info(`projectName: ${this.projectName}`);
      core.info(`localTesting: ${this.localTesting}`);
      core.info(`localLoggingLevel: ${this.localLoggingLevel}`);
      core.info(`localIdentifier: ${this.localIdentifier}`);
      core.info(`localArgs: ${this.localArgs}`);
    } catch (e) {
      core.setFailed(`Parsing of Input Failed: ${e}`);
    }
  }

  setEnvVariables() {
    core.exportVariable(ENV_VARS.BROWSERSTACK_USERNAME, this.username);
    core.exportVariable(ENV_VARS.BROWSERSTACK_ACCESS_KEY, this.accessKey);
    core.exportVariable(ENV_VARS.BROWSERSTACK_PROJECT_NAME, this.projectName);
    core.exportVariable(ENV_VARS.BROWSERSTACK_BUILD_NAME, this.buildName);
    core.exportVariable(ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER, this.localIdentifier);
  }
}

export default ActionInput;
