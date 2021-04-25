module.exports = {
  ENV_VARS: {
    BROWSERSTACK_USERNAME: 'BROWSERSTACK_USERNAME',
    BROWSERSTACK_ACCESS_KEY: 'BROWSERSTACK_ACCESS_KEY',
    BROWSERSTACK_PROJECT_NAME: 'BROWSERSTACK_PROJECT_NAME',
    FRAMEWORK: 'framework',
    APP_HASHED_ID: 'app_hashed_id',
    TEST_SUITE_ID: 'test_suite_id',
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
  },
  INPUT: {
    CONFIG_PATH: 'config-path',
    FRAMEWORK: 'framework',
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
