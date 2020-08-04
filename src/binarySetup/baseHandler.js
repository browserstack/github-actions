import * as tc from '@actions/tool-cache';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as path from 'path';
import constants from '../../config/constants';

const { LOCAL_BINARY_FOLDER } = constants;

class BaseHandler {
  static async _makeDirectory(platform) {
    const binaryFolder = path.resolve(process.env.HOME, 'work', 'executables', LOCAL_BINARY_FOLDER, platform);
    await io.mkdirP(binaryFolder);
    return binaryFolder;
  }

  async downloadBinary(zipURL) {
    try {
      const binaryFolder = await BaseHandler._makeDirectory(this.platform);
      const downloadPath = await tc.downloadTool(zipURL, path.resolve(binaryFolder, 'binaryZip'));
      const extractedPath = await tc.extractZip(downloadPath, binaryFolder);
      const cachedPath = await tc.cacheDir(extractedPath, this.toolName, '1.0.0');
      core.addPath(cachedPath);
      this.binaryPath = extractedPath;
    } catch (e) {
      core.setFailed(`Downloading Binary Failed: ${e.message}`);
    }
  }

  set binaryPath(value) {
    this.binaryPath = value;
  }

  get binaryPath() {
    return this.binaryPath;
  }
}

export default BaseHandler;
