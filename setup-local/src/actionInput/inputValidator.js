const core = require('@actions/core');
const { v4: uuidv4 } = require('uuid');
const parseArgs = require('minimist');
const constants = require('../../config/constants');

const {
  ALLOWED_INPUT_VALUES: {
    LOCAL_LOG_LEVEL,
    LOCAL_TESTING,
    LOCAL_IDENTIFIER_RANDOM,
  },
  INPUT,
  RESTRICTED_LOCAL_ARGS,
} = constants;

/**
 * InputValidator performs validation on the input fields of this
 * action. The fields are parsed and converted into the required format.
 */
class InputValidator {
  /**
   * Validates the action input 'local-testing' and returns the
   * parsed value.
   * Throws error if it's not a valid value
   * @param {String} inputLocalTesting Action input for 'local-testing'
   * @returns {String} One of the values from start/stop/false
   */
  static validateLocalTesting(inputLocalTesting) {
    const localTestingLowered = inputLocalTesting.toLowerCase();
    // eslint-disable-next-line max-len
    const validValue = Object.values(LOCAL_TESTING).some((allowedValue) => allowedValue === localTestingLowered);

    if (!validValue) {
      throw Error(`Invalid input for ${INPUT.LOCAL_TESING}. The valid inputs are: ${Object.values(LOCAL_TESTING).join(', ')}. Refer the README for more details`);
    }

    return localTestingLowered;
  }

  /**
   * Validates the action input 'local-logging-level' and returns the
   * verbosity level of logging.
   * @param {String} inputLocalLoggingLevel Action input for 'local-logging-level'
   * @returns {Number} Logging Level (0 - 3)
   */
  static validateLocalLoggingLevel(inputLocalLoggingLevel) {
    if (!inputLocalLoggingLevel) return 0;

    const loggingLevelLowered = inputLocalLoggingLevel.toString().toLowerCase();

    switch (loggingLevelLowered) {
      case LOCAL_LOG_LEVEL.SETUP_LOGS: {
        return 1;
      }
      case LOCAL_LOG_LEVEL.NETWORK_LOGS: {
        return 2;
      }
      case LOCAL_LOG_LEVEL.ALL_LOGS: {
        return 3;
      }
      case LOCAL_LOG_LEVEL.FALSE: {
        return 0;
      }
      default: {
        core.info(`[Warning] Invalid input for ${INPUT.LOCAL_LOGGING_LEVEL}. No logs will be captured. The valid inputs are: ${Object.values(LOCAL_LOG_LEVEL).join(', ')}`);
        return 0;
      }
    }
  }

  /**
   * Validates the local-identifier input. It handles the generation of random
   * identifier if required.
   * @param {String} inputLocalIdentifier Action input for 'local-identifier'
   * @returns {String} Parsed/Random local-identifier
   */
  static validateLocalIdentifier(inputLocalIdentifier) {
    if (!inputLocalIdentifier) return '';

    const localIdentifierParsed = inputLocalIdentifier.toString().toLowerCase().split(/\s+/).join('-');
    if (localIdentifierParsed === LOCAL_IDENTIFIER_RANDOM) {
      return `GitHubAction-${uuidv4()}`;
    }

    return localIdentifierParsed;
  }

  /**
   * Validates the local-args input. Removes any args which might conflict with
   * the input args taken from the action input for the Local Binary.
   * @param {String} inputLocalArgs Action input for 'local-args'
   * @returns {String} Parsed args
   */
  static validateLocalArgs(inputLocalArgs) {
    const parsedArgs = parseArgs(inputLocalArgs.split(/\s+/));

    delete parsedArgs._;
    RESTRICTED_LOCAL_ARGS.forEach((arg) => {
      delete parsedArgs[arg];
    });

    let parsedArgsString = '';
    for (const [key, value] of Object.entries(parsedArgs)) {
      const argKey = key.length === 1 ? `-${key}` : `--${key}`;
      const argValue = value === true ? '' : value;
      parsedArgsString += `${argKey} ${argValue} `;
    }

    return parsedArgsString;
  }
}

module.exports = InputValidator;
