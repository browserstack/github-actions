import * as github from '@actions/github';

class InputValidator {
  static validateUsername(inputUsername) {
    return `${inputUsername}-GitHubAction`;
  }

  static validateBuildName(inputBuildName) {
    const githubEvent = github.context.eventName;

    console.log('gitHubEvent: ', githubEvent);
    console.log('inputBuildName: ', inputBuildName);

    if (inputBuildName) {
      const buildNameWithHyphen = inputBuildName.split().join('-');
      const prIndex = buildNameWithHyphen.indexOf('META#');
      if (prIndex === -1) return buildNameWithHyphen;
    } else {
      switch (githubEvent) {
        case 'push': {
          // commit message of the latest commit in a push event,
          // i.e. push event comprising of multiple commits
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
          console.log('in pull request...');
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
          console.log('in default....');
          return `${githubEvent}-${github.context.sha.slice(0, 7)}`;
        }
      }
    }
  }

  static validateProjectName(inputProjectName) {
    if (inputProjectName) return inputProjectName.split(' ').join('-');

    return github.context.repo.repo;
  }
}

export default InputValidator;
