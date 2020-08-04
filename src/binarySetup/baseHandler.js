import * as tc from '@actions/tool-cache';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as path from 'path';
import constants from '../../config/constants';

const { LOCAL_BINARY_FOLDER } = constants;

class BaseHandler {
  async _makeDirectory() {
    try {
      const binaryFolder = path.resolve(process.env.HOME, 'work', 'executables', LOCAL_BINARY_FOLDER);
      console.log(`about to make a directory: ${binaryFolder}`);
      await io.mkdirP(binaryFolder);
      this.binaryFolder = binaryFolder;
    } catch (e) {
      core.setFailed(`Failed while creating directory for Local Binary: ${e.message}`);
    }
  }

  async downloadBinary(zipURL) {
    console.log('inside downloadBinary...');
    await this._makeDirectory();
    console.log('done with making directory. Will add in:', this.platform);
    const downloadPath = await tc.downloadTool(zipURL, path.resolve(this.binaryFolder, this.platform));
    console.log('downloaded:', downloadPath);
    const extractedPath = await tc.extractZip(downloadPath);
    console.log('extracted:', extractedPath);
    const cachedPath = await tc.cacheDir(extractedPath, 'BrowserStackLocal');
    console.log('adding to cache...');
    core.addPath(cachedPath);
  }
}

export default BaseHandler;
