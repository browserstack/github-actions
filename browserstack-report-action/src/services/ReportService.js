const axios = require('axios');
const core = require('@actions/core');
const constants = require('../../config/constants');

class ReportService {
  constructor(authHeader) {
    this.authHeader = authHeader;
    this.apiUrl = 'https://api-observability-preprod.bsstag.com/ext/v1/builds/buildReport';
  }

  async fetchReport(params) {
    try {
      const response = await axios.post(this.apiUrl, params, {
        headers: {
          Authorization: this.authHeader,
        },
      });

      if (response.status < 200 || response.status > 299) {
        core.info(`Error fetching report: ${response.status}`);
        return ReportService.errorResponse(response?.data?.errorMessage || "Something Went Wrong while Fetching report");
      }
      core.info(`Response from report API: ${response?.data?.reportStatus}`);
      return response.data;
    } catch (error) {
      core.info(`Error fetching report: ${error.message}`);
      return ReportService.errorResponse("Something Went Wrong while Fetching report");
    }
  }

  static errorResponse(errorMessage) {
    return {
      report: { basicHtml: `<pre>${errorMessage}</pre>` },
      reportStatus: 'ERROR',
    };
  }

  async pollReport(params, timeManager, maxRetries, pollingInterval) {
    timeManager.setPollingInterval(pollingInterval);
    const poll = async (retries) => {
      if (timeManager.checkTimeout()) {
        return ReportService.handleErrorStatus(constants.REPORT_STATUS.IN_PROGRESS);
      }

      const reportData = await this.fetchReport({
        ...params,
        requestType: retries === maxRetries - 1 ? constants.REPORT_REQUEST_STATE.LAST
          : constants.REPORT_REQUEST_STATE.POLL,
      });

      const status = reportData.reportStatus;
      if (status === constants.REPORT_STATUS.COMPLETED
        || status === constants.REPORT_STATUS.TEST_AVAILABLE
        || status === constants.REPORT_STATUS.NOT_AVAILABLE) {
        return reportData;
      }

      if (status === constants.REPORT_STATUS.IN_PROGRESS && retries < maxRetries) {
        await timeManager.sleep();
        return poll(retries + 1);
      }

      // Instead of throwing, return error data that can be displayed
      return this.handleErrorStatus(status, reportData);
    };

    return poll(0);
  }

  static handleErrorStatus(status, reportData = {}) {
    const errorMessages = {
      ERROR: 'Unable to Fetch Report',
      IN_PROGRESS: 'Report is still in progress',
    };

    return {
      errorMessage: errorMessages[status] || `Unexpected status: ${status}`,
      reportStatus: status,
      report: status === constants.REPORT_STATUS.IN_PROGRESS ? { basicHtml: '<pre>Report generation not completed, please try again after increasing report timeout</pre>' } : reportData.report,
    };
  }
}

module.exports = ReportService;
