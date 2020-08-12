const { expect } = require('chai');
const github = require('@actions/github');
const sinon = require('sinon');
const InputValidator = require('../../src/actionInput/inputValidator');

describe('InputValidator class to validate individual fields of the action input', () => {
  context('Public Static Methods', () => {
    context('Validates Username', () => {
      it("Returns the username with '-GitHubAction' suffix", () => {
        const inputUsername = 'someUsername';
        expect(InputValidator.validateUsername(inputUsername)).to.eq(`${inputUsername}-GitHubAction`);
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
});
