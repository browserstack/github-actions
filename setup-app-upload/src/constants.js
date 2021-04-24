module.exports = {
  ENV_VARS: {
    BROWSERSTACK_USERNAME: 'BROWSERSTACK_USERNAME',
    BROWSERSTACK_ACCESS_KEY: 'BROWSERSTACK_ACCESS_KEY',
    BROWSERSTACK_BUILD_NAME: 'BROWSERSTACK_BUILD_NAME',
    BROWSERSTACK_PROJECT_NAME: 'BROWSERSTACK_PROJECT_NAME',
    APP_PATH: 'app_path',
    FRAMEWORK: 'framework',
    TEST_SUITE: 'test_suite',
    APP_HASHED_ID: 'app_hashed_id',
    TEST_SUITE_ID: 'test_suite_id'
  },
  URLS: {
    BASE_URL: 'api-cloud.browserstack.com/app-automate',
    APP_UPLOAD_ENDPOINT: 'upload',
    FRAMEWORKS: {
      "espresso": 'espresso/v2/test-suite',
      "xcuitest": 'xcuitest/v2/test-suite'
    }
  },
  INPUT: {
    APP_PATH: 'app-path',
    FRAMEWORK: 'framework',
    TEST_SUITE: 'test-suite'
  }
};