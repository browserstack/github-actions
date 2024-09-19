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

  /**
   * Validates the rerun-attempt to ensure it is a valid number or 'none'.
   * If the input is 'none' or not provided, it returns -1.
   * @param {string} rerunAttempt Input for 'rerun-attempt'
   * @returns {number} The validated rerun-attempt as a number, or -1 if 'none' or invalid
   * @throws {Error} If the input is not a valid positive number or 'none'
   */
  static validateRerunAttempt(rerunAttempt) {
    if (rerunAttempt && rerunAttempt.toLowerCase() !== 'none') {
      const parsedAttempt = Number(rerunAttempt);
      if (!Number.isNaN(parsedAttempt) && parsedAttempt >= 0) {
        return parsedAttempt;
      }
      throw new Error("Invalid input for 'rerun-attempt'. Must be a positive number or 'none'.");
    }

    return -1;
  }

  /**
   * Validates the run-id to ensure it is a valid number or 'none'.
   * If the input is 'none' or not provided, it returns -1.
   * @param {string} runId Input for 'run-id'
   * @returns {number} The validated run-id as a number, or -1 if 'none' or invalid
   * @throws {Error} If the input is not a valid positive number or 'none'
   */
  static validateRunId(runId) {
    if (runId && runId.toLowerCase() !== 'none') {
      const parsedRunId = Number(runId);
      if (!Number.isNaN(parsedRunId) && parsedRunId >= 0) {
        return parsedRunId;
      }
      throw new Error("Invalid input for 'run-id'. Must be a positive number or 'none'.");
    }

    return -1;
  }

  /**
   * Validates the GitHub token input to ensure it is a valid non-empty string.
   * If the input is 'none' or not provided, it returns 'none'.
   * @param {string} githubToken Input for 'github-token'
   * @returns {string} The validated GitHub token, or 'none' if input is 'none' or invalid
   * @throws {Error} If the input is not a valid non-empty string
   */
  static validateGithubToken(githubToken) {
    if (githubToken && githubToken.toLowerCase() !== 'none') {
      if (typeof githubToken === 'string' && githubToken.trim().length > 0) {
        return githubToken;
      }
      throw new Error("Invalid input for 'github-token'. Must be a valid non-empty string.");
    }
    return 'none';
  }

  /**
   * Validates the repository input to ensure it is a valid non-empty string.
   * If the input is 'none' or not provided, it returns 'none'.
   * @param {string} repository Input for 'repository'
   * @returns {string} Validated repository name, or 'none' if input is 'none' or invalid
   * @throws {Error} If the input is not a valid non-empty string
   */
  static validateRepository(repository) {
    if (repository && repository.toLowerCase() !== 'none') {
      if (typeof repository === 'string' && repository.trim().length > 0) {
        return repository;
      }
      throw new Error("Invalid input for 'repository'. Must be a valid string.");
    }
    return 'none';
  }

  /**
   * Validates the app name input to ensure it is a valid non-empty string.
   * If the input is 'none' or not provided, it returns 'none'.
   * @param {string} githubAppName Input for 'repository'
   * @returns {string} Validated app name, or 'none' if input is 'none' or invalid
   * @throws {Error} If the input is not a valid non-empty string
   */
  static validateGithubAppName(githubAppName) {
    if (githubAppName && githubAppName.toLowerCase() !== 'bstack-gha-app[bot]') {
      if (typeof githubAppName === 'string' && githubAppName.trim().length > 0) {
        return githubAppName;
      }
      throw new Error("Invalid input for 'github-app'. Must be a valid string.");
    }
    return 'bstack-gha-app[bot]';
  }
}

module.exports = InputValidator;
