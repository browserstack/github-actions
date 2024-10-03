const { expect } = require('chai');
const github = require('@actions/github');
const sinon = require('sinon');
const InputValidator = require('../../src/actionInput/inputValidator');

describe('InputValidator class to validate individual fields of the action input', () => {
  context('Public Static Methods', () => {
    context('Validates Username', () => {
      it("Returns the username with '-GitHubAction' suffix", () => {
        const inputUsername = 'someUsername';
        expect(InputValidator.updateUsername(inputUsername)).to.eq(`${inputUsername}-GitHubAction`);
      });
    });

    context('Validates Build Name', () => {
      beforeEach(() => {
        sinon.stub(InputValidator, '_getBuildInfo').returns('someBuildInfo');
      });

      afterEach(() => {
        InputValidator._getBuildInfo.restore();
      });

      it("Returns the build name as it is if the input doesn't contain the keyword 'build_info' (case insensitive)", () => {
        const inputBuildName = 'this is the build name';
        expect(InputValidator.validateBuildName(inputBuildName)).to.eq(inputBuildName);
      });

      it("Returns the build info if the input is undefined", () => {
        expect(InputValidator.validateBuildName()).to.eq('someBuildInfo');
      });

      it("Returns the build info if the input is empty string", () => {
        expect(InputValidator.validateBuildName('')).to.eq('someBuildInfo');
      });

      it("Replaces the 'build_info' (case insensitive) keyword with the build info in users input", () => {
        expect(InputValidator.validateBuildName('some string buiLD_iNFo')).to.eq('some string someBuildInfo');
      });
    });

    context('Validates Project Name', () => {
      beforeEach(() => {
        sinon.stub(github, 'context').value({
          repo: {
            repo: 'someRepoName',
          },
        });
      });

      it('Returns the repository name if the input is empty stirng', () => {
        expect(InputValidator.validateProjectName('')).to.eq('someRepoName');
      });

      it('Returns the repository name if the input is undefined', () => {
        expect(InputValidator.validateProjectName()).to.eq('someRepoName');
      });

      it("Returns the repo name if the input is 'repo_name' keyword (case insensitive)", () => {
        expect(InputValidator.validateProjectName('RePo_NaME')).to.eq('someRepoName');
      });

      it("Returns the string input by the user as it is if input is not 'repo_name'", () => {
        expect(InputValidator.validateProjectName('some project')).to.eq('some project');
      });
    });
  });

  context('Private Static Methods', () => {
    context('Build Info Generation based on the GitHub EventType', () => {
      context('Push event', () => {
        beforeEach(() => {
          sinon.stub(github, 'context').value({
            payload: {
              head_commit: {
                message: 'messageOfHeadCommit',
              },
            },
            sha: 'someSHA',
            runNumber: 123,
            ref: 'refs/head/branchOrTagName',
            eventName: 'push',
          });
        });

        it('Generate build info with commit information', () => {
          const expectedValue = '[branchOrTagName] Commit someSHA: messageOfHeadCommit [Workflow: 123]';
          expect(InputValidator._getBuildInfo()).to.eq(expectedValue);
        });
      });

      context('Pull Request event', () => {
        beforeEach(() => {
          sinon.stub(github, 'context').value({
            payload: {
              pull_request: {
                head: {
                  ref: 'branchName',
                },
                title: 'prTitle',
              },
              number: 'prNumber',
            },
            runNumber: 123,
            eventName: 'pull_request',
          });
        });

        it('Generate build info with PR information', () => {
          const expectedValue = '[branchName] PR prNumber: prTitle [Workflow: 123]';
          expect(InputValidator._getBuildInfo()).to.eq(expectedValue);
        });
      });

      context('Release event', () => {
        beforeEach(() => {
          sinon.stub(github, 'context').value({
            payload: {
              release: {
                tag_name: 'tagName',
                target_commitish: 'branchName',
                name: 'releaseName',
              },
            },
            runNumber: 123,
            eventName: 'release',
          });
        });

        it('Generate build info with Release information where release name != tag name', () => {
          const expectedValue = '[branchName] Release tagName: releaseName [Workflow: 123]';
          expect(InputValidator._getBuildInfo()).to.eq(expectedValue);
        });

        it('Generate build info with Release information where release name == tag name', () => {
          github.context.payload.release.name = 'tagName';
          const expectedValue = '[branchName] Release tagName [Workflow: 123]';
          expect(InputValidator._getBuildInfo()).to.eq(expectedValue);
        });
      });

      context('Other event', () => {
        beforeEach(() => {
          sinon.stub(github, 'context').value({
            runNumber: 123,
            eventName: 'anyOtherEvent',
          });
        });

        it('Generate build info with basic event type and workflow run number', () => {
          const expectedValue = 'anyOtherEvent [Workflow: 123]';
          expect(InputValidator._getBuildInfo()).to.eq(expectedValue);
        });
      });

      context('Validates GitHub App Name', () => {
        it("Returns 'bstack-integrations[bot]' if the app name is not provided", () => {
          expect(() => InputValidator.validateGithubAppName()).to.throw("Invalid input for 'github-app'. Must be a valid string.");
        });

        it("Returns 'bstack-integrations[bot]' if the app name is 'bstack-integrations[bot]' (case insensitive)", () => {
          expect(InputValidator.validateGithubAppName('Bstack-integrations[BOT]')).to.eq('bstack-integrations[bot]');
        });

        it('Throws an error if the app name is an empty string', () => {
          expect(() => InputValidator.validateGithubAppName('')).to.throw("Invalid input for 'github-app'. Must be a valid string.");
        });

        it('Throws an error if the app name is not a valid string', () => {
          expect(() => InputValidator.validateGithubAppName(123)).to.throw("Invalid input for 'github-app'. Must be a valid string.");
        });

        it('Returns the app name if it is a valid non-empty string and not "bstack-integrations[bot]"', () => {
          const validAppName = 'someValidAppName';
          expect(InputValidator.validateGithubAppName(validAppName)).to.eq(validAppName);
        });
      });

      context('Validates GitHub Token', () => {
        it("Returns 'none' if the token is not provided", () => {
          expect(() => InputValidator.validateGithubToken()).to.throw("Invalid input for 'github-token'. Must be a valid non-empty string.");
        });

        it("Returns 'none' if the token is 'none' (case insensitive)", () => {
          expect(InputValidator.validateGithubToken('None')).to.eq('none');
        });

        it('Throws an error if the token is an empty string', () => {
          expect(() => InputValidator.validateGithubToken('')).to.throw("Invalid input for 'github-token'. Must be a valid non-empty string.");
        });

        it('Throws an error if the token is not a valid string', () => {
          expect(() => InputValidator.validateGithubToken(123)).to.throw("Invalid input for 'github-token'. Must be a valid non-empty string.");
        });

        it('Returns the token if it is a valid non-empty string and not "none"', () => {
          const validToken = 'someValidToken';
          expect(InputValidator.validateGithubToken(validToken)).to.eq(validToken);
        });
      });
    });
  });
});
