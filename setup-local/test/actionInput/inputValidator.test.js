const { expect } = require('chai');
const constants = require('../../config/constants');
const InputValidator = require('../../src/actionInput/inputValidator');

const {
  ALLOWED_INPUT_VALUES: {
    LOCAL_LOG_LEVEL,
    LOCAL_TESTING,
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
    });
  });
});
