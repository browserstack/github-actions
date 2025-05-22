const core = require('@actions/core');
const UploadFileForArtifact = require('../utils/UploadFileForArtifact');

class ReportProcessor {
  constructor(reportData) {
    this.reportData = reportData;
  }

  async processReport() {
    try {
      const { summary } = core;
      await summary.addHeading('BrowserStack Test Report');

      let addToSummaryReport = this.reportData?.report?.basicHtml;
      addToSummaryReport = `<html> ${addToSummaryReport} </html>`;
      core.info(`Report HTML: ${addToSummaryReport}`);
      if (addToSummaryReport) {
        await summary.addRaw(addToSummaryReport);
      } else {
        await summary.addRaw('⚠️ No report content available');
      }
      summary.write();
      const addToArtifactReport = this.reportData?.report?.richHtml;
      const addToArtifactReportCss = this.reportData?.report?.richCss;
      if (addToArtifactReport) {
        const report = `<!DOCTYPE html> <html><head><style>${addToArtifactReportCss}</style></head> ${addToArtifactReport}}</html>`;
        const artifactObj = new UploadFileForArtifact(report, 'browserstack-artifacts', 'browserstack-report.html', 'BrowserStack Test Report');
        await artifactObj.saveReportInFile();
      }
    } catch (error) {
      core.info(`Error processing report: ${JSON.stringify(error)}`);
      await core.summary
        .addRaw('❌ Error processing report')
        .write();
      throw error;
    }
  }
}

module.exports = ReportProcessor;
