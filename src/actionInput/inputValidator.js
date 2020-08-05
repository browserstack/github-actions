import * as github from '@actions/github';
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

class InputValidator {
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

  static validateUsername(inputUsername) {
    return `${inputUsername}-GitHubAction`;
  }

  static validateLocalTesting(inputLocalTesting) {
    if (!inputLocalTesting) return 'false';

    const localTestingLowered = inputLocalTesting.toString().toLowerCase();
    const validValue = LOCAL_TESTING.some((allowedValue) => allowedValue === localTestingLowered);

    if (!validValue) {
      throw Error(`Invalid input for ${INPUT.LOCAL_TESING}. The valid inputs are: ${LOCAL_TESTING.join(', ')}. Refer the README for more details`);
    }

    return validValue;
  }

  static validateLocalLoggingLevel(inputLocalLoggingLevel) {
    if (!inputLocalLoggingLevel) return '';

    const loggingLevelLowered = inputLocalLoggingLevel.toString().toLowerCase();

    switch (loggingLevelLowered) {
      case LOCAL_LOG_LEVEL.SETUP_LOGS: {
        return '--verbose 1 --log-file BrowserStackLocal.log';
      }
      case LOCAL_LOG_LEVEL.NETWORK_LOGS: {
        return '--verbose 2 --log-file BrowserStackLocal.log';
      }
      case LOCAL_LOG_LEVEL.ALL_LOGS: {
        return '--verbose 3 --log-file BrowserStackLocal.log';
      }
      case LOCAL_LOG_LEVEL.FALSE: {
        return '';
      }
      default: {
        console.log(`[Warning] Invalid input for ${INPUT.LOCAL_LOGGING_LEVEL}. No logs will be captured. The valid inputs are: ${Object.values(LOCAL_LOG_LEVEL).join(', ')}`);
        return '';
      }
    }
  }

  static validateLocalIdentifier(inputLocalIdentifier) {
    if (!inputLocalIdentifier) return '';

    const localIdentifierParsed = inputLocalIdentifier.toString().toLowerCase().split(/\s+/).join('-');
    if (localIdentifierParsed === LOCAL_IDENTIFIER_RANDOM) {
      return `GitHubAction-${uuidv4()}`;
    }

    return localIdentifierParsed;
  }

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

  static validateProjectName(inputProjectName) {
    if (inputProjectName) return inputProjectName.split(/\s+/).join('-');

    return github.context.repo.repo;
  }
}

export default InputValidator;
