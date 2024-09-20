module.exports = {
  INPUT: {
    USERNAME: 'username',
    ACCESS_KEY: 'access-key',
    BUILD_NAME: 'build-name',
    PROJECT_NAME: 'project-name',
    GITHUB_TOKEN: 'github-token',
    GITHUB_APP: 'github-app',
  },

  ENV_VARS: {
    BROWSERSTACK_USERNAME: 'BROWSERSTACK_USERNAME',
    BROWSERSTACK_ACCESS_KEY: 'BROWSERSTACK_ACCESS_KEY',
    BROWSERSTACK_BUILD_NAME: 'BROWSERSTACK_BUILD_NAME',
    BROWSERSTACK_PROJECT_NAME: 'BROWSERSTACK_PROJECT_NAME',
  },

  BROWSERSTACK_TEMPLATE: {
    // DETAILS_API_URL: 'https://integrate.browserstack.com/api/ci-tools/v1/builds/{runId}/rebuild/details?tool=github-actions&as_bot=true',
    DETAILS_API_URL: 'https://https://8c12-2405-201-6806-d09b-4d8a-335-3b92-fcbe.ngrok-free.app/api/ci-tools/v1/builds/{runId}/rebuild/details?tool=github-actions&as_bot=true',
  },
};
