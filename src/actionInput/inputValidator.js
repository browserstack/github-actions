import * as github from '@actions/github';
import * as core from '@actions/core';
import { v4 as uuidv4 } from 'uuid';
import * as parseArgs from 'minimist';

import constants from '../../config/constants';

const {
  ALLOWED_INPUT_VALUES: {
    LOCAL_LOG_LEVEL,
    LOCAL_TESTING,
    LOCAL_IDENTIFIER_RANDOM,
  },
  INPUT,
  RESTRICTED_LOCAL_ARGS,
} = constants;

/**
 * InputValidator performs validation on the input fields of this
 * action. The fields are parsed and converted into the required format.
 */
class InputValidator {
  /**
   * Generates metadata of the triggered workflow in the form of
   * 1. Push event (Non PR): Commit-\<commit-id>-\<commit-message>
   * 2. Pull Request event: PR-\<PR-number>-Commit-\<commit-id>
   * @returns {String} Metadata
   */
  static _getMetadata() {
    const githubEvent = github.context.eventName;
    switch (githubEvent) {
      case 'push': {
        const {
          context: {
            payload: {
              head_commit: {
                message: commitMessage,
              },
            },
            sha: commitSHA,
          },
        } = github;

        const parsedCommitMessage = commitMessage.split(/\s+/).join('-');
        return `Commit-${commitSHA.slice(0, 7)}-${parsedCommitMessage}`;
      }
      case 'pull_request': {
        const {
          context: {
            payload: {
              pull_request: {
                head: {
                  sha: commitSHA,
                },
              },
              number: prNumber,
            },
          },
        } = github;

        return `PR-${prNumber}-Commit-${commitSHA.slice(0, 7)}`;
      }
      default: {
        return `${githubEvent}-${github.context.sha.slice(0, 7)}`;
      }
    }
  }

  /**
   * Appends the username with '-GitHubAction' for internal instrumentation
   * @param {String} inputUsername BrowserStack Username
   * @returns {String} Modified Username
   */
  static validateUsername(inputUsername) {
    return `${inputUsername}-GitHubAction`;
  }

  /**
   * Validates the action input 'local-testing' and returns the
   * parsed value.
   * Throws error if it's not a valid value
   * @param {String} inputLocalTesting Action input for 'local-testing'
   * @returns {String} One of the values from start/stop/false
   */
  static validateLocalTesting(inputLocalTesting) {
    if (!inputLocalTesting) return 'false';

    const localTestingLowered = inputLocalTesting.toString().toLowerCase();
    // eslint-disable-next-line max-len
    const validValue = Object.values(LOCAL_TESTING).some((allowedValue) => allowedValue === localTestingLowered);

    if (!validValue) {
      throw Error(`Invalid input for ${INPUT.LOCAL_TESING}. The valid inputs are: ${Object.values(LOCAL_TESTING).join(', ')}. Refer the README for more details`);
    }

    return localTestingLowered;
  }

  /**
   * Validates the action input 'local-logging-level' and returns the
   * verbosity level of logging.
   * @param {String} inputLocalLoggingLevel Action input for 'local-logging-level'
   * @returns {Number} Logging Level (0 - 3)
   */
  static validateLocalLoggingLevel(inputLocalLoggingLevel) {
    if (!inputLocalLoggingLevel) return 0;

    const loggingLevelLowered = inputLocalLoggingLevel.toString().toLowerCase();

    switch (loggingLevelLowered) {
      case LOCAL_LOG_LEVEL.SETUP_LOGS: {
        return 1;
      }
      case LOCAL_LOG_LEVEL.NETWORK_LOGS: {
        return 2;
      }
      case LOCAL_LOG_LEVEL.ALL_LOGS: {
        return 3;
      }
      case LOCAL_LOG_LEVEL.FALSE: {
        return 0;
      }
      default: {
        core.info(`[Warning] Invalid input for ${INPUT.LOCAL_LOGGING_LEVEL}. No logs will be captured. The valid inputs are: ${Object.values(LOCAL_LOG_LEVEL).join(', ')}`);
        return 0;
      }
    }
  }

  /**
   * Validates the local-identifier input. It handles the generation of random
   * identifier if required.
   * @param {String} inputLocalIdentifier Action input for 'local-identifier'
   * @returns {String} Parsed/Random local-identifier
   */
  static validateLocalIdentifier(inputLocalIdentifier) {
    if (!inputLocalIdentifier) return '';

    const localIdentifierParsed = inputLocalIdentifier.toString().toLowerCase().split(/\s+/).join('-');
    if (localIdentifierParsed === LOCAL_IDENTIFIER_RANDOM) {
      return `GitHubAction-${uuidv4()}`;
    }

    return localIdentifierParsed;
  }

  /**
   * Validates the local-args input. Removes any args which might conflict with
   * the input args taken from the action input for the Local Binary.
   * @param {String} inputLocalArgs Action input for 'local-args'
   * @returns {String} Parsed args
   */
  static validateLocalArgs(inputLocalArgs) {
    const parsedArgs = parseArgs(inputLocalArgs.split(/\s+/));

    delete parsedArgs._;
    RESTRICTED_LOCAL_ARGS.forEach((arg) => {
      delete parsedArgs[arg];
    });

    let parsedArgsString = '';
    for (const [key, value] of Object.entries(parsedArgs)) {
      const argKey = key.length === 1 ? `-${key}` : `--${key}`;
      const argValue = value === true ? '' : value;
      parsedArgsString += `${argKey} ${argValue} `;
    }

    return parsedArgsString;
  }

  /**
   * Validates the build-name based on the input type. It performs the following:
   * 1. Removes any spaces from the input provided.
   * 2. Adds metadata information of the PR/Commit if required (based on the input format).
   * @param {String} inputBuildName Action input for 'build-name'
   * @returns {String} Parsed/Modified Build Name
   */
  static validateBuildName(inputBuildName) {
    if (!inputBuildName) return InputValidator._getMetadata();

    let buildNameWithHyphen = inputBuildName.split(/\s+/).join('-');
    const prIndex = buildNameWithHyphen.indexOf('META#');

    if (prIndex === -1) return buildNameWithHyphen;

    const metadata = InputValidator._getMetadata();

    if (prIndex === 0) {
      buildNameWithHyphen = buildNameWithHyphen.split('META#-')[1];
      return buildNameWithHyphen ? `${metadata}-${buildNameWithHyphen}` : metadata;
    }

    buildNameWithHyphen = buildNameWithHyphen.split('-META#')[0];
    return buildNameWithHyphen ? `${buildNameWithHyphen}-${metadata}` : metadata;
  }

  /**
   * Validates the project-name. It performs the following:
   * 1. Removes any spaces from the input provided.
   * 2. (or) Considers the Repository name as the project name if no input is provided.
   * @param {String} inputProjectName Action input for 'project-name'
   * @returns {String} Parsed/Repository name as Project Name
   */
  static validateProjectName(inputProjectName) {
    if (inputProjectName) return inputProjectName.split(/\s+/).join('-');

    return github.context.repo.repo;
  }
}

export default InputValidator;
