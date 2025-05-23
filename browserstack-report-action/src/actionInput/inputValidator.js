const github = require('@actions/github');
const constants = require('../../config/constants');

/**
 * InputValidator performs validation on the input fields of the action.
 * The fields are parsed and converted into the required format.
 */
class InputValidator {
  /**
   * Generates metadata of the triggered workflow based on the type of event.
   * Supported events:
   * 1. Push
   * 2. Pull Request
   * 3. Release
   * 4. Other events
   * @returns {String} Metadata
   */
  static _getBuildInfo() {
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
            runNumber: workflowNumber,
            ref,
          },
        } = github;

        const probableBranchOrTag = ref.split('/').pop();
        const slicedSHA = commitSHA.slice(0, 7);
        return `[${probableBranchOrTag}] Commit ${slicedSHA}: ${commitMessage} [Workflow: ${workflowNumber}]`;
      }
      case 'pull_request': {
        const {
          context: {
            payload: {
              pull_request: {
                head: { ref: branchName },
                title: prTitle,
              },
              number: prNumber,
            },
            runNumber: workflowNumber,
          },
        } = github;

        return `[${branchName}] PR ${prNumber}: ${prTitle} [Workflow: ${workflowNumber}]`;
      }
      case 'release': {
        const {
          context: {
            payload: {
              release: {
                tag_name: tagName,
                target_commitish: branchName,
                name: releaseName,
              },
            },
            runNumber: workflowNumber,
          },
        } = github;

        return `[${branchName}] Release ${tagName}${releaseName === tagName ? ' ' : `: ${releaseName} `}[Workflow: ${workflowNumber}]`;
      }
      default: {
        return `${githubEvent} [Workflow: ${github.context.runNumber}]`;
      }
    }
  }

  static updateUsername(inputUsername) {
    return `${inputUsername}-GitHubAction`;
  }

  /**
   * Validates the build-name based on the input.
   * If no build name is provided, generates one using workflow name and run ID.
   * @param {String} buildName - Action input for 'build-name'
   * @param {String} workflow - The GitHub workflow name
   * @param {String} runId - The GitHub run ID
   * @returns {String} Validated/default build name
   */
  static validateBuildName(inputBuildName) {
    if (!inputBuildName) return InputValidator._getBuildInfo();

    const prIndex = inputBuildName.toLowerCase().indexOf('build_info');

    if (prIndex === -1) return inputBuildName;

    const metadata = InputValidator._getBuildInfo();
    return inputBuildName.replace(/build_info/i, metadata);
  }

  /**
   * Validates the user-timeout input.
   * Ensures it's a positive number or uses the default.
   * @param {String} userTimeout - Action input for 'user-timeout'
   * @returns {Number} Validated user timeout value
   */
  static validateUserTimeout(userTimeout) {
    if (!userTimeout) {
      return constants.DEFAULT_USER_TIMEOUT_SECONDS;
    }

    const timeoutValue = parseInt(userTimeout, 10);
    if (Number.isNaN(timeoutValue) || timeoutValue <= 0) {
      return constants.DEFAULT_USER_TIMEOUT_SECONDS;
    }

    return timeoutValue;
  }
}

module.exports = InputValidator;
