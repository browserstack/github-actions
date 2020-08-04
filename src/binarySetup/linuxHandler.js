import * as tc from '@actions/tool-cache';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as path from 'path';
import constants from '../../config/constants';

const { BINARY_PATHS: { LINUX }, LOCAL_BINARY_FOLDER } = constants;

class LinuxHandler {
  async makeDirectory() {
    try {
      const binaryFolder = path.resolve(process.env.HOME, LOCAL_BINARY_FOLDER);
      await io.mkdirP(binaryFolder);
      this.binaryFolder = binaryFolder;
    } catch (e) {
      core.setFailed(`Failed while creating directory for Local Binary: ${e.message}`);
    }
  }

  async downloadBinary() {
    const downloadPath = await tc.downloadTool(LINUX, this.binaryFolder);
    await tc.extractZip(downloadPath);
    const cachedPath = await tc.cacheDir(this.binaryFolder, 'BrowserStackLocal');
    core.addPath(cachedPath);
  }
}

export default LinuxHandler;
