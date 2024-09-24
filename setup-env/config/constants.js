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

  BROWSERSTACK_INTEGRATIONS: {
    DETAILS_API_URL: 'https://integrate.bsstag.com/api/ci-tools/v1/builds/{runId}/rebuild/details?tool=github-actions&as_bot=true',
  },
};
