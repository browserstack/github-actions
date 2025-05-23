const core = require('@actions/core');
const constants = require('../config/constants');
const ActionInput = require('./actionInput');
const ReportService = require('./services/ReportService');
const ReportProcessor = require('./services/ReportProcessor');
const TimeManager = require('./utils/TimeManager');

async function run() {
  try {
    core.info('Starting BrowserStack Report Action...');

    const actionInput = new ActionInput();
    const {
      username, accessKey, buildName, userTimeout,
    } = actionInput.getInputs();
    const authHeader = `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;

    const timeManager = new TimeManager(userTimeout
      || constants.DEFAULT_USER_TIMEOUT_SECONDS);
    const reportService = new ReportService(authHeader);

    const initialParams = {
      originalBuildName: buildName,
      requestingCi: constants.CI_SYSTEM.GITHUB_ACTIONS,
      reportFormat: [constants.REPORT_FORMAT.BASIC_HTML, constants.REPORT_FORMAT.RICH_HTML],
      requestType: constants.REPORT_REQUEST_STATE.FIRST,
      userTimeout,
    };

    timeManager.checkTimeout();
    let reportData = await reportService.fetchReport(initialParams);
    let { retryCount: maxRetries, pollingInterval } = reportData;

    if (!pollingInterval) {
      pollingInterval = constants.DEFAULT_POLLING_INTERVAL_SECONDS;
    }

    if (!maxRetries) {
      maxRetries = constants.DEFAULT_MAX_RETRIES;
    }

    if (reportData.reportStatus === constants.REPORT_STATUS.IN_PROGRESS) {
      reportData = await reportService.pollReport(
        initialParams,
        timeManager,
        maxRetries,
        pollingInterval,
      );
    }

    const reportProcessor = new ReportProcessor(reportData);
    await reportProcessor.processReport();
    core.info('Report processing completed successfully');
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

module.exports = { run };

if (require.main === module) {
  run();
}
