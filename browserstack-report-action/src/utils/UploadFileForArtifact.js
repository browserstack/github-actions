const fs = require('fs');
const path = require('path');
const core = require('@actions/core');

class UploadFileForArtifact {
  constructor(report, pathName, fileName, artifactName) {
    this.report = report;
    this.pathName = pathName;
    this.fileName = fileName;
    this.artifactName = artifactName;
  }

  async saveReportInFile() {
    if (!this.report) {
      core.debug('No HTML content available to save as artifact');
      return '';
    }

    try {
      // Create artifacts directory
      fs.mkdirSync(this.pathName, { recursive: true });
      // save path in a env variable
      core.exportVariable('BROWSERSTACK_REPORT_PATH', this.pathName);
      core.exportVariable("BROWSERSTACK_REPORT_NAME", this.artifactName);

      // Write content
      fs.writeFileSync(path.join(this.pathName, this.fileName), this.report);
    } catch (error) {
      core.warning(`Failed to save file: ${error.message}`);
      return '';
    }
  }
}

module.exports = UploadFileForArtifact;
