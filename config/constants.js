export default {
  INPUT: {
    USERNAME: 'username',
    ACCESS_KEY: 'access-key',
    LOCAL_TESING: 'local-testing',
    LOCAL_LOGGING_LEVEL: 'local-logging-level',
    LOCAL_IDENTIFIER: 'local-identifier',
    LOCAL_ARGS: 'local-args',
    BUILD_NAME: 'build-name',
    PROJECT_NAME: 'project-name',
  },

  PLATFORMS: {
    LINUX: 'linux',
    DARWIN: 'darwin',
    WIN32: 'win32',
  },

  ENV_VARS: {
    BROWSERSTACK_USERNAME: 'BROWSERSTACK_USERNAME',
    BROWSERSTACK_ACCESS_KEY: 'BROWSERSTACK_ACCESS_KEY',
    BROWSERSTACK_LOCAL_IDENTIFIER: 'BROWSERSTACK_LOCAL_IDENTIFIER',
    BROWSERSTACK_BUILD_NAME: 'BROWSERSTACK_BUILD_NAME',
    BROWSERSTACK_PROJECT_NAME: 'BROWSERSTACK_PROJECT_NAME',
  },

  BINARY_LINKS: {
    LINUX_32: 'https://www.browserstack.com/browserstack-local/BrowserStackLocal-linux-ia32.zip',
    LINUX_64: 'https://www.browserstack.com/browserstack-local/BrowserStackLocal-linux-x64.zip',
    WINDOWS: 'https://www.browserstack.com/browserstack-local/BrowserStackLocal-win32.zip',
    DARWIN: 'https://www.browserstack.com/browserstack-local/BrowserStackLocal-darwin-x64.zip',
  },

  ALLOWED_INPUT_VALUES: {
    LOCAL_TESTING: {
      START: 'start',
      STOP: 'stop',
      FALSE: 'false',
    },
    LOCAL_LOG_LEVEL: {
      SETUP_LOGS: 'setup-logs',
      NETWORK_LOGS: 'network-logs',
      ALL_LOGS: 'all-logs',
      FALSE: 'false',
    },
    LOCAL_IDENTIFIER_RANDOM: 'random',
  },

  RESTRICTED_LOCAL_ARGS: ['k', 'key', 'local-identifier', 'daemon', 'only-automate', 'verbose', 'log-file'],

  LOCAL_BINARY_FOLDER: 'LocalBinaryFolder',
  LOCAL_BINARY_NAME: 'BrowserStackLocal',
  LOCAL_LOGGING_FILE: 'BrowserStackLocal.log',
};
