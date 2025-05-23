module.exports = {
  // Default values
  DEFAULT_POLLING_INTERVAL_SECONDS: 3,
  DEFAULT_MAX_RETRIES: 3,
  DEFAULT_USER_TIMEOUT_SECONDS: 120,

  // API simulation constants
  MAX_POLLS_FOR_IN_PROGRESS: 3,

  // Report formats
  REPORT_FORMAT: {
    BASIC_HTML: 'basicHtml',
    RICH_HTML: 'richHtml',
  },

  INPUT: {
    USERNAME: 'username',
    ACCESS_KEY: 'access-key',
    BUILD_NAME: 'build-name',
    TIMEOUT: 'report-timeout',
  },

  // Report statuses
  REPORT_STATUS: {
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    TEST_AVAILABLE: 'TEST_AVAILABLE',
    NOT_AVAILABLE: 'NOT_AVAILABLE',
    BUILD_NOT_FOUND: 'BUILD_NOT_FOUND',
    MULTIPLE_BUILD_FOUND: 'MULTIPLE_BUILD_FOUND',
  },

  // Integration types
  INTEGRATION_TYPE: {
    SDK: 'sdk',
    NON_SDK: 'non-sdk',
  },

  // CI system identifiers
  CI_SYSTEM: {
    GITHUB_ACTIONS: 'github-actions',
  },

  // REPORT_REQUEST_STATE
  REPORT_REQUEST_STATE: {
    FIRST: 'FIRST',
    POLL: 'POLL',
    LAST: 'LAST',
  },
};
