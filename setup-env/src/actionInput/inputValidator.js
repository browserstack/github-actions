const github = require('@actions/github');

/**
 * InputValidator performs validation on the input fields of this
 * action. The fields are parsed and converted into the required format.
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
        const slicedCommitMessage = commitMessage.slice(0,200);
        return `[${probableBranchOrTag}] Commit ${slicedSHA}: ${slicedCommitMessage} [Workflow: ${workflowNumber}]`;
      }
      case 'pull_request': {
        const {
          context: {
            payload: {
              pull_request: {
                head: {
                  ref: branchName,
                },
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

  /**
   * Appends the username with '-GitHubAction' for internal instrumentation
   * @param {String} inputUsername BrowserStack Username
   * @returns {String} Modified Username
   */
  static updateUsername(inputUsername) {
    return `${inputUsername}-GitHubAction`;
  }

  /**
   * Validates the build-name based on the input type. It performs the following:
   * 1. Checks if 'build_info' (case insensitive) exists in the input
   * 2. Adds metadata information of the PR/Commit if required (based on the input format).
   * @param {String} inputBuildName Action input for 'build-name'
   * @returns {String} Parsed/Modified Build Name
   */
  static validateBuildName(inputBuildName) {
    if (!inputBuildName) return InputValidator._getBuildInfo();

    const prIndex = inputBuildName.toLowerCase().indexOf('build_info');

    if (prIndex === -1) return inputBuildName;

    const metadata = InputValidator._getBuildInfo();
    return inputBuildName.replace(/build_info/i, metadata);
  }

  /**
   * Validates the project-name. It performs the following:
   * 1. Checks if there is no input or the input is 'repo_name' (case insensitive)
   * 2. If input is provided for the project name other than 'repo_name'
   * @param {String} inputProjectName Action input for 'project-name'
   * @returns {String} Project name
   */
  static validateProjectName(inputProjectName) {
    if (!inputProjectName || inputProjectName.toLowerCase() === 'repo_name') return github.context.repo.repo;

    return inputProjectName;
  }
}

module.exports = InputValidator;
