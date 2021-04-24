const request = require('request');
const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const constants = require('./constants');
const {
  URLS,
  ENV_VARS
} = constants;


class Uploader {
  static _upload(file_path, endpoint, env_var) {
    var options = {
      'method': 'POST',
      'url': `https://${this.username}:${this.accesskey}@${URLS.BASE_URL}/${endpoint}`,
      formData: {
        'file': {
          'value': fs.createReadStream(file_path),
          'options': {
            'filename': path.parse(file_path).base,
            'contentType': null
          }
        },
        "skip_dedup": "true"
      }
    };
    request(options, function (error, response) {
      if (error) core.setFailed(error.message);
      if(response.statusCode != 200) {
        core.setFailed(response.body); 
      } else {
        var content = JSON.parse(response.body);
        var id = content.app_url ? content.app_url : content.test_suite_url
        core.info(`uploaded comeplete ${env_var}:${id}`);
        core.exportVariable(env_var, id)
      }
    });
  }

  static run() {
    try {
      this.username = process.env[ENV_VARS.BROWSERSTACK_USERNAME];
      this.accesskey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
      const app_path = process.env[ENV_VARS.APP_PATH];
      if(app_path) this._upload(app_path, URLS.APP_UPLOAD_ENDPOINT, ENV_VARS.APP_HASHED_ID);
      const framework = process.env[ENV_VARS.FRAMEWORK];
      const test_suite = process.env[ENV_VARS.TEST_SUITE];
      if(test_suite) this._upload(test_suite, URLS.FRAMEWORKS[framework], ENV_VARS.TEST_SUITE_ID);
    } catch (error) {
      core.setFailed(error.message);
    }
  }
}

module.exports = Uploader;