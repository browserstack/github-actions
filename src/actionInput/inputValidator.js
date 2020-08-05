import * as github from '@actions/github';

class InputValidator {
  static _getMetadata(githubEvent) {
    switch (github.context.eventName) {
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

  static validateBuildName(inputBuildName) {
    if (!inputBuildName) return InputValidator._getMetadata();

    const buildNameWithHyphen = inputBuildName.split(' ').join('-');
    const prIndex = buildNameWithHyphen.indexOf('META#');

    if (prIndex === -1) return buildNameWithHyphen;

    const metadata = InputValidator._getMetadata();
    return prIndex === 0 ? `${buildNameWithHyphen}-${metadata}` : `${metadata}-${buildNameWithHyphen}`;
  }

  static validateProjectName(inputProjectName) {
    if (inputProjectName) return inputProjectName.split(' ').join('-');

    return github.context.repo.repo;
  }
}

export default InputValidator;
