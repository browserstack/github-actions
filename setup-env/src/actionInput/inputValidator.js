const github = require('@actions/github');

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
  static validateUsername(inputUsername) {
    return `${inputUsername}-GitHubAction`;
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

    const prIndex = inputBuildName.toLowerCase().indexOf('build_info');

    if (prIndex === -1) return inputBuildName;

    const metadata = InputValidator._getMetadata();
    return inputBuildName.replace(/build_info/i, metadata);
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

module.exports = InputValidator;
