module.exports = {
  ENV_VARS: {
    BROWSERSTACK_USERNAME: 'BROWSERSTACK_USERNAME',
    BROWSERSTACK_ACCESS_KEY: 'BROWSERSTACK_ACCESS_KEY',
    BROWSERSTACK_PROJECT_NAME: 'BROWSERSTACK_PROJECT_NAME',
    BROWSERSTACK_LOCAL_IDENTIFIER: 'BROWSERSTACK_LOCAL_IDENTIFIER',
    FRAMEWORK: 'BROWSERSTACK_FRAMEWORK',
    APP_HASHED_ID: 'BROWSERSTACK_APP_HASHED_ID',
    TEST_SUITE_ID: 'BROWSERSTACK_TEST_SUITE_ID',
  },
  FRAMEWORKS: {
    espresso: 'espresso',
    xcuitest: 'xcuitest',
  },
  URLS: {
    BASE_URL: 'api-cloud.browserstack.com/app-automate',
    APP_UPLOAD_ENDPOINT: 'upload',
    FRAMEWORKS: {
      espresso: 'espresso/v2/build',
      xcuitest: 'xcuitest/v2/build',
    },
    WATCH_FRAMEWORKS: {
      espresso: 'espresso/v2/builds',
      xcuitest: 'xcuitest/v2/builds',
    },
    REPORT: {
      espresso: 'report',
      xcuitest: 'resultbundle',
    },
    DASHBOARD_BASE: 'app-automate.browserstack.com/dashboard/v2/builds',
  },
  INPUT: {
    CONFIG_PATH: 'config-path',
    FRAMEWORK: 'framework',
    ASYNC: 'async',
    UPLOAD: 'upload',
  },
  WATCH_INTERVAL: 60000,
  TEST_STATUS: {
    RUNNING: 'running',
    QUEUED: 'queued',
    PASSED: 'passed',
    ERROR: 'error',
    TIMED_OUT: 'timed_out',
    FAILED: 'failed',
    SKIPPED: 'skipped',
  },
};
