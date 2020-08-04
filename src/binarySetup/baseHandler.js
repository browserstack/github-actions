import * as tc from '@actions/tool-cache';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as path from 'path';
import constants from '../../config/constants';

const { LOCAL_BINARY_FOLDER } = constants;

class BaseHandler {
  static async _makeDirectory(binaryFolder) {
    console.log('in makeDirectory, binaryFOlder: ', binaryFolder);
    await io.mkdirP(binaryFolder);
    console.log('made the directory..');
  }

  async downloadBinary(zipURL) {
    try {
      await BaseHandler._makeDirectory(this.binaryFolder);
      console.log('binary folder: ', binaryFolder);
      const downloadPath = await tc.downloadTool(zipURL, path.resolve(binaryFolder, 'binaryZip'));
      console.log('downloaded the binary: ', downloadPath);
      const extractedPath = await tc.extractZip(downloadPath, binaryFolder);
      console.log('extracted path: ', extractedPath);
      const cachedPath = await tc.cacheDir(extractedPath, this.toolName, '1.0.0');
      console.log('cachedPath: ', cachedPath);
      core.addPath(cachedPath);
      this.binaryPath = extractedPath;
    } catch (e) {
      core.setFailed(`Downloading Binary Failed: ${e.message}`);
    }
  }
}

export default BaseHandler;
