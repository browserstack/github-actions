import * as tc from '@actions/tool-cache';
import * as core from '@actions/core';
import constants from '../../config/constants';

const { BINARY_PATHS: { LINUX } } = constants;

class LinuxHandler {
  async downloadBinary() {
    const downloadPath = await tc.downloadTool(LINUX, process.env.HOME);
    this.binaryPath = tc.extractZip(downloadPath, process.env.HOME);
    const cachedPath = await tc.cacheDir(this.binaryPath, 'BrowserStackLocal');
    core.addPath(cachedPath);
  }
}

export default LinuxHandler;
