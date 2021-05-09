const core = require('@actions/core');
const request = require('request');
const Table = require('cli-table');
const fs = require('fs');
const constants = require("../config/constants");

const {
  URLS,
  ENV_VARS,
  INPUT,
  WATCH_INTERVAL,
  TEST_STATUS,
} = constants;

class TestRunner {
  constructor() {
    this._setConfig();
  }

  _getValues() {
    try {
      this.username = process.env[ENV_VARS.BROWSERSTACK_USERNAME].replace("-GitHubAction", ""); // remove suffix as api endpoint doesn't accept it
      this.accesskey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
      const configPath = core.getInput(INPUT.CONFIG_PATH);
      this.config = JSON.parse(fs.readFileSync(configPath));
      this.app_hashed_id = process.env[ENV_VARS.APP_HASHED_ID];
      this.test_suite_hashed_id = process.env[ENV_VARS.TEST_SUITE_ID];
      this.framework = core.getInput(INPUT.FRAMEWORK) || process.env[ENV_VARS.FRAMEWORK];
    } catch (e) {
      throw Error(`Action input failed for reason: ${e.message}`);
    }
  }

  _setConfig() {
    this._getValues();
    this.config.app = this.config.app || this.app_hashed_id;
    this.config.testSuite = this.config.testSuite || this.test_suite_hashed_id;
    const localIdentifier = process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER];
    // set localIdentifier from setup-local action
    if (localIdentifier) this.config.localIdentifier = localIdentifier;
    const project = this.config.project || process.env[ENV_VARS.BROWSERSTACK_PROJECT_NAME];
    if (project) this.config.project = project;
    this.config['browserstack.source'] = "GitHubAction"; // adding custom internal cap for tracking the number of build from plugin
  }

  _startBuild() {
    return new Promise((resolve, reject) => {
      const options = {
        url: `https://${this.username}:${this.accesskey}@${URLS.BASE_URL}/${URLS.FRAMEWORKS[this.framework]}`,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.config),
      };

      core.info(`starting a new ${this.framework} build with following configuration \n ${JSON.stringify(this.config)}`);

      request.post(options, (error, response) => {
        if (error) reject(error.message);
        if (response.statusCode !== 200) {
          reject(JSON.parse(response.body));
        } else {
          const content = JSON.parse(response.body);
          if (content.message === "Success") {
            core.info(`Build started build id:${content.build_id}`);
            this.build_id = content.build_id;
            resolve();
          } else {
            reject(content);
          }
        }
      });
    });
  }

  static _parseApiResult(content) {
    core.info(`Build current status: ${content.status}`);
    const devicesArray = content.devices;
    const table = new Table({
      head: ['Device', 'OS', 'ID', 'Status', 'Total', 'Passed', 'Failed', 'Skipped', 'Timedout', 'Error', 'Running', 'Queued'],
    });
    devicesArray.forEach((deviceInfo) => {
      const deviceMeta = [];
      deviceMeta.push(deviceInfo.device);
      deviceMeta.push(deviceInfo.os_version);
      const deviceSessions = deviceInfo.sessions;
      deviceSessions.forEach((session) => {
        const row = [...deviceMeta];
        row.push(session.id);
        row.push(session.status);
        if (session.testcases) {
          row.push(session.testcases.count);
          row.push(...Object.values(session.testcases.status));
          table.push(row);
        }
      });
    });
    core.info(table.toString());
  }

  _pollBuild() {
    return new Promise((resolve, reject) => {
      const poller = setInterval(() => {
        const options = {
          url: `https://${this.username}:${this.accesskey}@${URLS.BASE_URL}/${URLS.WATCH_FRAMEWORKS[this.framework]}/${this.build_id}`,
        };
        request.get(options, (error, response) => {
          if (error) {
            clearInterval(poller);
            reject(error.message);
          }
          if (response.statusCode !== 200) {
            clearInterval(poller);
            reject(response.body);
          } else {
            const content = JSON.parse(response.body);
            if ([TEST_STATUS.RUNNING, TEST_STATUS.QUEUED].includes(content.status)) {
              TestRunner._parseApiResult(content);
              core.info("waiting for the tests to run ...");
            } else {
              clearInterval(poller);
              TestRunner._parseApiResult(content);
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
      if (this.build_status !== TEST_STATUS.PASSED) {
        core.setFailed(`Browserstack Build with build id: ${this.build_id} ${this.build_status}`);
      }
    } catch (e) {
      core.setFailed(e.message);
    }
  }
}

module.exports = TestRunner;
