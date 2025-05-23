const { expect } = require('chai');
const sinon = require('sinon');
const github = require('@actions/github');
const InputValidator = require('../../src/actionInput/inputValidator');
const constants = require('../../config/constants');

describe('InputValidator', () => {
  describe('validateBuildName', () => {
    let githubContextStub;

    beforeEach(() => {
      // Setup GitHub context stub with all possible event payloads
      githubContextStub = {
        eventName: 'push',
        payload: {
          head_commit: {
            message: 'test commit message',
          },
          pull_request: {
            head: { ref: 'feature-branch' },
            title: 'Test PR Title',
            number: 123,
          },
          release: {
            tag_name: 'v1.0.0',
            target_commitish: 'main',
            name: 'Release v1.0.0',
          },
        },
        sha: 'abcdef1234567890',
        runNumber: '42',
        ref: 'refs/heads/main',
      };

      // Stub github.context
      sinon.stub(github, 'context').value(githubContextStub);
    });

    afterEach(() => {
      sinon.restore();
    });

    context('with push events', () => {
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

    context('with pull_request events', () => {
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

      it('returns PR metadata for empty build name', () => {
        const result = InputValidator.validateBuildName('');
        expect(result).to.equal('[branchName] PR prNumber: prTitle [Workflow: 123]');
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

    it('returns original build name when no placeholder exists', () => {
      const buildName = 'My Custom Build';
      const result = InputValidator.validateBuildName(buildName);
      expect(result).to.equal(buildName);
    });

    it('handles case-insensitive build_info placeholder', () => {
      const result = InputValidator.validateBuildName('Test-BUILD_INFO-Suite');
      expect(result).to.include('Test-');
      expect(result).to.include('-Suite');
      expect(result).to.include('[main]');
    });
  });

  describe('validateUserTimeout', () => {
    it('accepts valid positive number string', () => {
      expect(InputValidator.validateUserTimeout('600')).to.equal(600);
    });

    it('returns default for empty string', () => {
      expect(InputValidator.validateUserTimeout('')).to.equal(constants.DEFAULT_USER_TIMEOUT_SECONDS);
    });

    it('returns default for undefined', () => {
      expect(
        InputValidator.validateUserTimeout(undefined),
      ).to.equal(constants.DEFAULT_USER_TIMEOUT_SECONDS);
    });

    it('returns default for null', () => {
      expect(
        InputValidator.validateUserTimeout(null),
      ).to.equal(constants.DEFAULT_USER_TIMEOUT_SECONDS);
    });

    it('returns default for non-numeric string', () => {
      expect(InputValidator.validateUserTimeout('not-a-number')).to.equal(constants.DEFAULT_USER_TIMEOUT_SECONDS);
    });

    it('returns default for negative number', () => {
      expect(InputValidator.validateUserTimeout('-100')).to.equal(constants.DEFAULT_USER_TIMEOUT_SECONDS);
    });

    it('returns default for zero', () => {
      expect(InputValidator.validateUserTimeout('0')).to.equal(constants.DEFAULT_USER_TIMEOUT_SECONDS);
    });

    it('handles decimal numbers by truncating', () => {
      expect(InputValidator.validateUserTimeout('123.45')).to.equal(123);
    });

    it('handles large valid numbers', () => {
      expect(InputValidator.validateUserTimeout('3600')).to.equal(3600);
    });
  });
});
