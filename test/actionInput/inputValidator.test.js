const github = require('@actions/github');
const { expect } = require('chai');
const constants = require('../../config/constants');
const InputValidator = require('../../src/actionInput/inputValidator');

const {
  ALLOWED_INPUT_VALUES: {
    LOCAL_LOG_LEVEL,
    LOCAL_TESTING,
    LOCAL_IDENTIFIER_RANDOM,
  },
  INPUT,
  RESTRICTED_LOCAL_ARGS,
} = constants;

describe('InputValidator class to validate individual fields of the action input', () => {
  context('Public Static Methods', () => {
    context('Validates Username', () => {
      it("Returns the username with '-GitHubAction' suffix", () => {
        const inputUsername = 'someUsername';
        expect(InputValidator.validateUsername(inputUsername)).to.eq(`${inputUsername}-GitHubAction`);
      });
    });

    context('Validates whether Local Testing is required or not', () => {
      it(`Returns 'start' if the input value is ${LOCAL_TESTING.START}`, () => {
        const inputLocalTesting = 'start';
        expect(InputValidator.validateLocalTesting(inputLocalTesting)).to.eq('start');
      });

      it(`Returns 'stop' if the input value is ${LOCAL_TESTING.STOP}`, () => {
        const inputLocalTesting = 'stop';
        expect(InputValidator.validateLocalTesting(inputLocalTesting)).to.eq('stop');
      });

      // null and undefined are not possible since core.getInput returns an empty string if no input
      // is given to an action input field. But the test case is added without considering any
      // handling done outside its scope.
      [LOCAL_TESTING.FALSE, '', null, undefined].forEach((value) => {
        it(`Returns 'false' if the input value is ${JSON.stringify(value)}`, () => {
          const inputLocalTesting = value;
          expect(InputValidator.validateLocalTesting(inputLocalTesting)).to.eq('false');
        });
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
    });
  });
});
