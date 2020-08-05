import * as github from '@actions/github';

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
