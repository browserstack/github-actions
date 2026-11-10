const core = require('@actions/core');
const { v4: uuidv4 } = require('uuid');
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

    const loggingLevelLowered = inputLocalLoggingLevel.toLowerCase();

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

    if (inputLocalIdentifier.toLowerCase() === LOCAL_IDENTIFIER_RANDOM) {
      return `GitHubAction-${uuidv4()}`;
    }

    return inputLocalIdentifier.split(/\s+/).join('-');
  }

  /**
   * Splits a string into tokens on whitespace, keeping single/double quoted
   * sections together (the quotes themselves are removed).
   * @param {String} argString Raw args string
   * @returns {Array<String>} Tokens
   */
  static _tokenizeArgs(argString) {
    const tokens = [];
    let current = '';
    let inToken = false;
    let quoteChar = null;

    for (const char of argString) {
      if (quoteChar) {
        if (char === quoteChar) {
          quoteChar = null;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        quoteChar = char;
        inToken = true;
      } else if (/\s/.test(char)) {
        if (inToken) {
          tokens.push(current);
          current = '';
          inToken = false;
        }
      } else {
        current += char;
        inToken = true;
      }
    }
    if (inToken) tokens.push(current);

    return tokens;
  }

  /**
   * Quotes a token for the command line consumed by @actions/exec, which
   * understands double quotes and backslash-escaped double quotes (other
   * backslashes are passed through untouched).
   * @param {String} token Single arg token
   * @returns {String} Token safe to place in the command string
   */
  static _quoteArg(token) {
    if (!/[\s"]/.test(token)) return token;
    return `"${token.replace(/"/g, '\\"')}"`;
  }

  /**
   * Validates the local-args input. Removes any args which might conflict with
   * the input args taken from the action input for the Local Binary.
   * Every value following a flag is preserved, so flags taking multiple values
   * (e.g. --include-hosts host1 host2) are passed to the binary intact.
   * @param {String} inputLocalArgs Action input for 'local-args'
   * @returns {String} Parsed args
   */
  static validateLocalArgs(inputLocalArgs) {
    if (!inputLocalArgs) return '';

    const tokens = InputValidator._tokenizeArgs(inputLocalArgs);
    const isFlag = (token) => /^-{1,2}[^-\d]/.test(token);

    const keptTokens = [];
    // Tokens before the first flag have no flag to belong to and are dropped.
    let keepCurrentGroup = false;
    tokens.forEach((token) => {
      if (isFlag(token)) {
        const flagName = token.replace(/^-{1,2}/, '').split('=')[0];
        keepCurrentGroup = !RESTRICTED_LOCAL_ARGS.includes(flagName);
      }
      if (keepCurrentGroup) keptTokens.push(InputValidator._quoteArg(token));
    });

    return keptTokens.join(' ');
  }
}

module.exports = InputValidator;
