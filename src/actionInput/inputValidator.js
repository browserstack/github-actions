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
          let commitMessage = github.context.payload.head_commit.message;
          commitMessage = commitMessage.split(' ').join('-');
          return `Commit-${github.context.sha.slice(0, 7)}-${commitMessage}}`;
        }
        case 'pull_request': {
          return `PR-${github.context.payload.number}-Commit-${github.context.payload.pull_request.head.sha.slice(0, 7)}`;
        }
        default: {
          return `${githubEvent}-${github.context.sha.slice(0, 7)}`;
        }
      }
    }
  }
}

export default InputValidator;
