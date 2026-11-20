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
    DETAILS_API_URL: 'https://integrations-k8s.bsstag.com/api/ci-tools/v1/builds/{runId}/rebuild/details?tool=github-actions&as_bot=true',
  },

  // Security (APS-19076): allowlist of env-var names accepted from the
  // BrowserStack rerun API response. Without this filter, the unbounded
  // Object.keys(...).forEach(core.exportVariable, ...) call let any caller
  // who could influence the API response inject arbitrary env vars into
  // the workflow runner (CVSS 9.3 - env-var injection).
  // Must list every name the rebuild/details response actually carries; a name missing
  // here is dropped silently from the runner's perspective (only a ::warning:: in the log).
  ALLOWED_RERUN_ENV_VARS: [
    'BROWSERSTACK_RERUN',
    'BROWSERSTACK_RERUN_TESTS',
    'BROWSERSTACK_BUILD_NAME',
    // SDK-7461: the SDKs read this as build_run_identifier in the build-start payload;
    // without it a re-run is filed as an unrelated build run instead of an attempt of its parent.
    'BROWSERSTACK_BUILD_RUN_IDENTIFIER',
  ],
};
