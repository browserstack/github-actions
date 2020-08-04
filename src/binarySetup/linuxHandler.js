import BaseHandler from './baseHandler';
import constants from '../../config/constants';

const { BINARY_PATHS: { LINUX } } = constants;

class LinuxHandler extends BaseHandler {
  constructor() {
    super();
    this.platform = 'linux';
    this.toolName = 'BrowserStackLocal';
  }

  async downloadBinary() {
    await super.downloadBinary(LINUX);
  }

  getBinaryPath() {
    return this.binaryPath;
  }
}

export default LinuxHandler;
