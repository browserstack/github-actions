const core = require('@actions/core');
const { expect } = require('chai');
const sinon = require('sinon');
const { argStringToArray } = require('@actions/exec/lib/toolrunner');
const constants = require('../../config/constants');
const InputValidator = require('../../src/actionInput/inputValidator');

const {
  ALLOWED_INPUT_VALUES: {
    LOCAL_LOG_LEVEL,
    LOCAL_TESTING,
    LOCAL_IDENTIFIER_RANDOM,
  },
  INPUT,
} = constants;

describe('InputValidator class to validate individual fields of the action input', () => {
  context('Public Static Methods', () => {
    context('Validates whether Local Testing is start/stop', () => {
      it(`Returns 'start' if the input value is ${LOCAL_TESTING.START}`, () => {
        const inputLocalTesting = 'start';
        expect(InputValidator.validateLocalTesting(inputLocalTesting)).to.eq('start');
      });

      it(`Returns 'stop' if the input value is ${LOCAL_TESTING.STOP}`, () => {
        const inputLocalTesting = 'stop';
        expect(InputValidator.validateLocalTesting(inputLocalTesting)).to.eq('stop');
      });

      it(`Throws error if the input is not from: ${Object.values(LOCAL_TESTING).join(', ')}`, () => {
        const expectedErrorMsg = `Invalid input for ${INPUT.LOCAL_TESING}. The valid inputs are: ${Object.values(LOCAL_TESTING).join(', ')}. Refer the README for more details`;
        try {
          InputValidator.validateLocalTesting('someRandomInput');
        } catch (e) {
          expect(e.message).to.eq(expectedErrorMsg);
        }
      });
    });

    context('Validates local logging level and decides the verbosity level', () => {
      it(`Returns 1 if the input is ${LOCAL_LOG_LEVEL.SETUP_LOGS}`, () => {
        expect(InputValidator.validateLocalLoggingLevel(LOCAL_LOG_LEVEL.SETUP_LOGS)).to.eq(1);
      });

      it(`Returns 2 if the input is ${LOCAL_LOG_LEVEL.NETWORK_LOGS}`, () => {
        expect(InputValidator.validateLocalLoggingLevel(LOCAL_LOG_LEVEL.NETWORK_LOGS)).to.eq(2);
      });

      it(`Returns 3 if the input is ${LOCAL_LOG_LEVEL.ALL_LOGS}`, () => {
        expect(InputValidator.validateLocalLoggingLevel(LOCAL_LOG_LEVEL.ALL_LOGS)).to.eq(3);
      });

      [LOCAL_LOG_LEVEL.FALSE, undefined, '', 'someRandomValue'].forEach((value) => {
        it(`Returns 0 if the input is ${JSON.stringify(value)}`, () => {
          sinon.stub(core, 'info');
          expect(InputValidator.validateLocalLoggingLevel(value)).to.eq(0);
          core.info.restore();
        });
      });
    });

    context('Validates local identifier', () => {
      it("Returns the idenfier joined by '-' if the input is not 'random'", () => {
        const inputLocalIdentifer = 'This is The identifier';
        const expectedOutput = 'This-is-The-identifier';
        expect(InputValidator.validateLocalIdentifier(inputLocalIdentifer)).to.eq(expectedOutput);
      });

      ['', null, undefined].forEach((value) => {
        it(`Returns empty string if the input is :${JSON.stringify(value)}`, () => {
          expect(InputValidator.validateLocalIdentifier(value)).to.eq('');
        });
      });

      it("Returns a unique identifier prefixed with 'GitHubAction-' when the input is 'random' (case insensitive)", () => {
        expect(InputValidator.validateLocalIdentifier(LOCAL_IDENTIFIER_RANDOM)).to.match(/GitHubAction-[a-z0-9-]{36}/);
      });
    });

    context('Validates local args', () => {
      it('Removes the restricted/not-alowed args from the local-args input and returns the string', () => {
        const inputLocalArgs = '--key someKey --proxy-host hostname --someOtherKey someValue -z --daemon start --ci-plugin someName -k anotherKey --only-automate --log-file some/path/ --verbose level --local-identifier someIdentifier';
        const expectedLocalArgs = '--proxy-host hostname --someOtherKey someValue -z';
        expect(InputValidator.validateLocalArgs(inputLocalArgs)).to.eq(expectedLocalArgs);
      });

      ['', null, undefined].forEach((value) => {
        it(`Returns empty string if the input is :${JSON.stringify(value)}`, () => {
          expect(InputValidator.validateLocalArgs(value)).to.eq('');
        });
      });

      it('Keeps every value of a flag that takes multiple values (quoted)', () => {
        const inputLocalArgs = '--include-hosts "hostA.example.com:443" "hostB.example.com:443" --force-local';
        const expectedLocalArgs = '--include-hosts hostA.example.com:443 hostB.example.com:443 --force-local';
        expect(InputValidator.validateLocalArgs(inputLocalArgs)).to.eq(expectedLocalArgs);
      });

      it('Keeps every value of a flag that takes multiple values (unquoted, multi-line)', () => {
        const inputLocalArgs = '--include-hosts hostA.example.com\n  hostB.example.com\n--exclude-hosts hostC hostD';
        const expectedLocalArgs = '--include-hosts hostA.example.com hostB.example.com --exclude-hosts hostC hostD';
        expect(InputValidator.validateLocalArgs(inputLocalArgs)).to.eq(expectedLocalArgs);
      });

      it('Removes the values of restricted args even when they have multiple values', () => {
        const inputLocalArgs = '--include-hosts hostA hostB --verbose 3 extra --local-identifier=abc --key=secret --proxy-port 8080';
        const expectedLocalArgs = '--include-hosts hostA hostB --proxy-port 8080';
        expect(InputValidator.validateLocalArgs(inputLocalArgs)).to.eq(expectedLocalArgs);
      });

      it('Drops tokens that appear before the first flag', () => {
        expect(InputValidator.validateLocalArgs('stray value --force-local')).to.eq('--force-local');
      });

      it('Keeps negative numbers as values rather than treating them as flags', () => {
        expect(InputValidator.validateLocalArgs('--some-flag -1 --other')).to.eq('--some-flag -1 --other');
      });

      it('Re-quotes values containing whitespace or double quotes', () => {
        const inputLocalArgs = `--folder "/path with spaces/dir" --name 'say "hi"'`;
        const expectedLocalArgs = '--folder "/path with spaces/dir" --name "say \\"hi\\""';
        expect(InputValidator.validateLocalArgs(inputLocalArgs)).to.eq(expectedLocalArgs);
      });

      it('Produces a string that @actions/exec splits back into the intended argv', () => {
        const inputLocalArgs = `--include-hosts "hostA:443" "hostB:443" --folder "C:\\my dir\\site" --name 'say "hi"'`;
        const parsed = argStringToArray(InputValidator.validateLocalArgs(inputLocalArgs));
        expect(parsed).to.deep.eq([
          '--include-hosts', 'hostA:443', 'hostB:443',
          '--folder', 'C:\\my dir\\site',
          '--name', 'say "hi"',
        ]);
      });
    });
  });
});
