const request = require('request');
const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const constants = require('../config/constants');

const {
  INPUT,
  URLS,
  ENV_VARS,
} = constants;

class Uploader {
  static _upload(filePath, fileUrl, endpoint, envVar) {
    const username = process.env[ENV_VARS.BROWSERSTACK_USERNAME];
    const accessKey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];

    const formData = {};

    if (filePath) {
      formData.file = {
        value: fs.createReadStream(filePath),
        options: {
          filename: path.parse(filePath).base,
          contentType: null,
        },
      };
    }

    if (fileUrl) formData.url = { value: fileUrl };

    const options = {
      url: `https://${username}:${accessKey}@${URLS.BASE_URL}/${endpoint}`,
      formData,
    };

    request.post(options, (error, response) => {
      if (error) core.setFailed(error.message);
      if (response.statusCode !== 200) {
        core.setFailed(response.body);
      } else {
        const content = JSON.parse(response.body);
        const id = content.app_url ? content.app_url : content.test_suite_url;
        core.info(`uploaded complete ${envVar}:${id}`);
        core.exportVariable(envVar, id);
      }
    });
  }

  static run() {
    try {
      const appPath = core.getInput(INPUT.APP_PATH);
      const framework = core.getInput(INPUT.FRAMEWORK);
      const appUrl = core.getInput(INPUT.APP_URL);
      const appUploadUrl = framework ? URLS.APP_FRAMEWORKS[framework] : URLS.APP_UPLOAD_ENDPOINT;
      if (appPath || appUrl) this._upload(appPath, appUrl, appUploadUrl, ENV_VARS.APP_HASHED_ID);
      const testSuite = core.getInput(INPUT.TEST_SUITE);
      const testSuiteUrl = core.getInput(INPUT.TEST_SUITE_URL);
      const testSuiteUploadUrl = URLS.TESTSUITE_FRAMEWORKS[framework];
      if (testSuite || testSuiteUrl) {
        this._upload(testSuite, testSuiteUrl, testSuiteUploadUrl, ENV_VARS.TEST_SUITE_ID);
      }
    } catch (error) {
      core.setFailed(error.message);
    }
  }
}

module.exports = Uploader;
