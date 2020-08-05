import * as tc from '@actions/tool-cache';
import * as io from '@actions/io';
import * as core from '@actions/core';
import * as os from 'os';
import * as path from 'path';
import constants from '../config/constants';

const {
  BINARY_LINKS,
  LOCAL_BINARY_FOLDER,
  PLATFORMS,
  LOCAL_BINARY_NAME,
} = constants;

class BinaryControl {
  constructor() {
    this.platform = os.platform();

    // decides the binary link and the folder to store the binary based on the
    // platform and the architecture
    if (this.platform === PLATFORMS.DARWIN) {
      this.binaryLink = BINARY_LINKS.DARWIN;
      this.binaryFolder = path.resolve(process.env.HOME, 'work', 'executables', LOCAL_BINARY_FOLDER, this.platform);
    } else if (this.platform === PLATFORMS.LINUX) {
      this.binaryLink = os.arch() === 'x32' ? BINARY_LINKS.LINUX_32 : BINARY_LINKS.LINUX_64;
      this.binaryFolder = path.resolve(process.env.HOME, 'work', 'executables', LOCAL_BINARY_FOLDER, this.platform);
    } else if (this.platform === PLATFORMS.WIN32) {
      this.binaryLink = BINARY_LINKS.WINDOWS;
      this.binaryFolder = path.resolve(process.env.GITHUB_WORKSPACE, '..', '..', 'work', 'executables', LOCAL_BINARY_FOLDER, this.platform);
    }
  }

  async _makeDirectory() {
    await io.mkdirP(this.binaryFolder);
  }

  async downloadBinary() {
    try {
      await this._makeDirectory();
      const downloadPath = await tc.downloadTool(this.binaryLink, path.resolve(this.binaryFolder, 'binaryZip'));
      const extractedPath = await tc.extractZip(downloadPath, this.binaryFolder);
      const cachedPath = await tc.cacheDir(extractedPath, LOCAL_BINARY_NAME, '1.0.0');
      core.addPath(cachedPath);
      this.binaryPath = extractedPath;
    } catch (e) {
      core.setFailed(`Downloading Binary Failed: ${e.message}`);
    }
  }
}

export default BinaryControl;
