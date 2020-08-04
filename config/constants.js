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

  ENV_VARS: {
    BROWSERSTACK_USERNAME: 'BROWSERSTACK_USERNAME',
    BROWSERSTACK_ACCESS_KEY: 'BROWSERSTACK_ACCESS_KEY',
    BROWSERSTACK_LOCAL_IDENTIFIER: 'BROWSERSTACK_LOCAL_IDENTIFIER',
    BROWSERSTACK_BUILD_NAME: 'BROWSERSTACK_BUILD_NAME',
    BROWSERSTACK_PROJECT_NAME: 'BROWSERSTACK_PROJECT_NAME',
  },

  BINARY_PATHS: {
    LINUX: 'https://www.browserstack.com/browserstack-local/BrowserStackLocal-linux-x64.zip',
    WINDOWS: 'https://www.browserstack.com/browserstack-local/BrowserStackLocal-win32.zip',
    DARWIN: 'https://www.browserstack.com/browserstack-local/BrowserStackLocal-darwin-x64.zip',
  },
};
