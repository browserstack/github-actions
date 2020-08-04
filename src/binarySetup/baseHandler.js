import * as tc from '@actions/tool-cache';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as path from 'path';
import constants from '../../config/constants';

const { LOCAL_BINARY_FOLDER } = constants;

class BaseHandler {
  async _makeDirectory() {
    try {
      const binaryFolder = path.resolve(process.env.HOME, LOCAL_BINARY_FOLDER);
      await io.mkdirP(binaryFolder);
      this.binaryFolder = binaryFolder;
    } catch (e) {
      core.setFailed(`Failed while creating directory for Local Binary: ${e.message}`);
    }
  }

  async downloadBinary(zipURL) {
    console.log('inside downloadBinary...');
    await this._makeDirectory();
    const downloadPath = await tc.downloadTool(zipURL, this.binaryFolder);
    await tc.extractZip(downloadPath);
    const cachedPath = await tc.cacheDir(this.binaryFolder, 'BrowserStackLocal');
    core.addPath(cachedPath);
  }
}

export default BaseHandler;
