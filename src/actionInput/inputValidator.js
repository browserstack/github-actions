import * as github from '@actions/github';
import * as core from '@actions/core';
import constants from '../../config/constants';

const { ALLOWED_INPUT_VALUES, INPUT } = constants;

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

        const parsedCommitMessage = commitMessage.split(' ').join('-');
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
    const validValue = ALLOWED_INPUT_VALUES.LOCAL_TESTING.some((allowedValue) => {
      return allowedValue === localTestingLowered;
    });

    if (!validValue) {
      core.setFailed(`Invalid input for ${INPUT.LOCAL_TESING}. The valid inputs are: ${ALLOWED_INPUT_VALUES.LOCAL_TESTING}. Refer the README for more details`);
    }

    return validValue;
  }

  static validateBuildName(inputBuildName) {
    if (!inputBuildName) return InputValidator._getMetadata();

    let buildNameWithHyphen = inputBuildName.split(' ').join('-');
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
    if (inputProjectName) return inputProjectName.split(' ').join('-');

    return github.context.repo.repo;
  }
}

export default InputValidator;
