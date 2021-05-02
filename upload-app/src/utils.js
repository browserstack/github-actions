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
  static _upload(filePath, endpoint, envVar) {
    const username = process.env[ENV_VARS.BROWSERSTACK_USERNAME];
    const accessKey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];

    const options = {
      url: `https://${username}:${accessKey}@${URLS.BASE_URL}/${endpoint}`,
      formData: {
        file: {
          value: fs.createReadStream(filePath),
          options: {
            filename: path.parse(filePath).base,
            contentType: null,
          },
        },
      },
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
      if (appPath) this._upload(appPath, URLS.APP_UPLOAD_ENDPOINT, ENV_VARS.APP_HASHED_ID);
      const framework = core.getInput(INPUT.FRAMEWORK);
      const testSuite = core.getInput(INPUT.TEST_SUITE);
      if (testSuite) this._upload(testSuite, URLS.FRAMEWORKS[framework], ENV_VARS.TEST_SUITE_ID);
    } catch (error) {
      core.setFailed(error.message);
    }
  }
}

module.exports = Uploader;
