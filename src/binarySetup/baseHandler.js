import * as tc from '@actions/tool-cache';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as path from 'path';

class BaseHandler {
  async _makeDirectory() {
    await io.mkdirP(this.binaryFolder);
  }

  async downloadBinary(zipURL) {
    try {
      await this._makeDirectory();
      const downloadPath = await tc.downloadTool(zipURL, path.resolve(this.binaryFolder, 'binaryZip'));
      const extractedPath = await tc.extractZip(downloadPath, this.binaryFolder);
      const cachedPath = await tc.cacheDir(extractedPath, this.toolName, '1.0.0');
      core.addPath(cachedPath);
      this.binaryPath = extractedPath;
    } catch (e) {
      core.setFailed(`Downloading Binary Failed: ${e.message}`);
    }
  }
}

export default BaseHandler;
