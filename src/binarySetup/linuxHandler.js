import * as path from 'path';
import BaseHandler from './baseHandler';
import constants from '../../config/constants';

const { BINARY_PATHS: { LINUX } } = constants;

class LinuxHandler extends BaseHandler {
  constructor() {
    super();
    this.platform = 'linux';
    this.toolName = 'BrowserStackLocal';
    this.binaryFolder = path.resolve(process.env.HOME, 'work', 'executables', this.platform);
  }

  async downloadBinary() {
    await super.downloadBinary(LINUX);
  }

  getBinaryPath() {
    return this.binaryPath;
  }
}

export default LinuxHandler;
