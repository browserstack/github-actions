const core = require('@actions/core');
const github = require('@actions/github');
const constants = require('./constants');
const request = require('request');
const Table = require('cli-table');
const fs = require('fs');


const {
  URLS,
  ENV_VARS,
  INPUT,
  WATCH_INTERVAL,
  TEST_STATUS
} = constants;

class TestRunner {
  constructor() {
    this._setConfig();
    this._validateInput();
  }

  _getValues() {
    try {
      this.username = process.env[ENV_VARS.BROWSERSTACK_USERNAME].replace("-GitHubAction", ""); // remove suffix as api endpoint doesn't accept it
      this.accesskey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
      var config_path = core.getInput(INPUT.CONFIG_PATH);
      this.config = JSON.parse(fs.readFileSync(config_path));
      this.app_hashed_id = process.env[ENV_VARS.APP_HASHED_ID];
      this.test_suite_hashed_id = process.env[ENV_VARS.TEST_SUITE_ID];
      this.framework = process.env[ENV_VARS.FRAMEWORK];
    }
    catch(e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  _setConfig() {
    this._getValues()
    this.config["app"] = this.config["app"] || this.app_hashed_id;
    this.config["testSuite"] = this.config["testsuite"] || this.test_suite_hashed_id;
  }

  _validateInput() {
  }

  _startBuild() {
    return new Promise( (resolve, reject) => { 
      var options = {
        'method': 'POST',
        'url': `https://${this.username}:${this.accesskey}@${URLS.BASE_URL}/${URLS.FRAMEWORKS[this.framework]}`,
        'headers': {
          'Content-Type': 'application/json'
        },
        'body': JSON.stringify(this.config)
      };

      core.info(`starting a new ${this.framework} build with following configuration \n ${JSON.stringify(this.config)}`);

      request(options, (error, response) => {
        if (error) reject(error.message);
        if(response.statusCode != 200) {
          reject(JSON.parse(response.body)); 
        } else {
          var content = JSON.parse(response.body);
          if(content.message === "Success") {
            core.info(`Build started build id:${content.build_id}`);
            this.build_id = content.build_id
            resolve();
          } else {
            reject(content);
          }
        }
      });
    });
  }

  _parseApiResult(content) {
    core.info(`Build current status: ${content.status}`);
    let devices_array = content.devices;
    var table = new Table({
        head: ['Device', 'OS', 'Status', 'ID', 'Total', 'Passed', 'Failed', 'Skipped', 'Timedout', 'Error', 'Running', 'Queued']
    });
    devices_array.forEach((device_info) => {
      let device_meta = []
      device_meta.push(device_info.device);
      device_meta.push(device_info.os_version);
      let device_sessions = device_info.sessions;
      device_sessions.forEach((session) => {
        let row = [...device_meta];
        row.push(session.status);
        row.push(session.id);
        if(session.testcases) {
          row.push(session.testcases.count);
          row.push(session.testcases.status.passed);
          row.push(session.testcases.status.failed);
          row.push(session.testcases.status.skipped);
          row.push(session.testcases.status.timedout);
          row.push(session.testcases.status.error);
          row.push(session.testcases.status.running);
          row.push(session.testcases.status.queued);
          table.push(row);
        }
      })
    });
    core.info(table.toString());
  }

  _pollBuild() {
    return new Promise( (resolve, reject) => {
      let poller = setInterval(() => {
        var options = {
          'method': 'GET',
          'url': `https://${this.username}:${this.accesskey}@${URLS.BASE_URL}/${URLS.WATCH_FRAMEWORKS[this.framework]}/${this.build_id}`,
        };
        request(options, (error, response) => {
          if (error) { 
            clearInterval(poller);
            reject(error.message);
          }
          if(response.statusCode != 200) {
            clearInterval(poller);
            reject(response.body); 
          } else {
            var content = JSON.parse(response.body);
            if([ TEST_STATUS.RUNNING, TEST_STATUS.QUEUED].includes(content.status)) {
              this._parseApiResult(content);
              core.info("waiting for the tests to run ...");
            } else {
              clearInterval(poller);
              this._parseApiResult(content);
              this.build_status = content.status;
              resolve();
            }
          }
        });
      }, WATCH_INTERVAL);
    });
  }

  async run() {
    try {
      await this._startBuild();
      await this._pollBuild();
      if(this.build_status != TEST_STATUS.PASSED) {
        core.setFailed(`Browserstack Build with build id: ${this.build_id} ${this.build_status}`);
      }
    } catch(e) {
      core.setFailed(e.message);
    }
  }
}

module.exports = TestRunner;
