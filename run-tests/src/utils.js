const core = require('@actions/core');
const request = require('request');
const Table = require('cli-table');
const fs = require('fs');
const artifacts = require('@actions/artifact');
const constants = require("../config/constants");

const {
  URLS,
  ENV_VARS,
  INPUT,
  WATCH_INTERVAL,
  TEST_STATUS,
  FRAMEWORKS,
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
      this.async = core.getInput(INPUT.ASYNC);
      this.upload = core.getInput(INPUT.UPLOAD);
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

  static _updateStatus(finalStatus, currentStatus) {
    if (!Object.keys(finalStatus).length) return currentStatus;
    const resultStatus = {};
    Object.keys(finalStatus).forEach((key) => {
      resultStatus[key] = finalStatus[key] + currentStatus[key];
    });
    return resultStatus;
  }

  static _pickKeys(keys, hash) {
    const result = [];
    keys.forEach((key) => {
      result.push(hash[key]);
    });
    return result;
  }

  static _parseApiResult(content) {
    core.info(`Build current status: ${content.status}`);
    const devicesArray = content.devices;
    let statuses = {}; // will be storing total count of various tests
    const tempTable = []; // will be storing intermediate info for each session
    const tempStatus = []; // will be storing test status hashes for each session

    // for every session created extract properties to tempTable
    // extract the status hash specific to test in tempStatus
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
          tempTable.push(row);
          tempStatus.push(session.testcases.status);
          statuses = TestRunner._updateStatus(statuses, session.testcases.status);
        }
      });
    });

    if (!tempTable.length) return; // return in case of no session data

    // filter out statuses having no tests
    const nonZeroStatus = Object.keys(statuses).filter((key) => statuses[key] > 0);

    const headers = ['Device', 'OS', 'ID', 'Status', 'Total'];
    headers.push(...nonZeroStatus);
    const table = new Table({
      head: headers,
    });
    // tempTable already has rows for each session with device, os, id, status, total
    // need to add split of tests as per specific status
    tempTable.forEach((row, index) => {
      tempTable[index].push(...TestRunner._pickKeys(nonZeroStatus, tempStatus[index]));
    });

    table.push(...tempTable);
    core.info(table.toString());
    return tempTable;
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
              resolve(content);
            }
          }
        });
      }, WATCH_INTERVAL);
    });
  }

  static async _uploadResults(content) {
    const promises = [];
    core.info(`Uploading test report artifacts for build id: ${content.id}`);
    const { devices, id: buildId, framework } = content;
    for (const device of devices) {
      const { sessions } = device;
      for (const session of sessions) {
        const { id } = session;
        const options = {
          url: `https://${this.username}:${this.accesskey}@${URLS.BASE_URL}/${URLS.WATCH_FRAMEWORKS[framework]}/${buildId}/sessions/${id}/${URLS.REPORT[framework]}`,
        };
        /* eslint-disable no-eval */
        promises.push(new Promise((resolve, reject) => {
          request.get(options, (error, response) => {
            if (error) {
              reject(error);
            }
            if (response.statusCode !== 200) {
              reject(response.body);
            }
            resolve(response.body);
          });
        }).then(async (report) => {
          if (!fs.existsSync('./reports')) {
            fs.mkdirSync('./reports');
          }
          if (framework === FRAMEWORKS.espresso) {
            fs.writeFileSync(`./reports/${id}.xml`, report);
          } else if (framework === FRAMEWORKS.xcuitest) {
            fs.writeFileSync(`./reports/${id}.zip`, report);
          }
        }).catch((err) => {
          core.error(err);
        }));
      }
    }
    await Promise.all(promises);
    if (process.env.ACTIONS_RUNTIME_TOKEN) {
      try {
        const files = fs.readdirSync('./reports');
        await artifacts.create().uploadArtifact('reports', files, './reports');
      } catch (err) {
        core.error(err);
      }
    }
  }

  async run() {
    try {
      await this._startBuild();
      const dashboardUrl = `https://${URLS.DASHBOARD_BASE}/${this.build_id}`;
      core.info(`Build Dashboard link: ${dashboardUrl}`);
      if (this.async) return;
      const content = await this._pollBuild();
      if (this.upload) await TestRunner._uploadResults(content);
      if (this.build_status !== TEST_STATUS.PASSED) {
        core.setFailed(`Browserstack Build with build id: ${this.build_id} ${this.build_status}`);
      }
    } catch (e) {
      core.setFailed(e.message);
    }
  }
}

module.exports = TestRunner;
