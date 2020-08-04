import * as path from 'path';
import BaseHandler from './baseHandler';
import constants from '../../config/constants';

const { BINARY_PATHS: { DARWIN } } = constants;

class DarwinHandler extends BaseHandler {
  constructor() {
    super();
    this.platform = 'darwin';
    this.toolName = 'BrowserStackLocal';
    this.binaryFolder = path.resolve(process.env.HOME, 'work', 'executables', this.platform);
  }

  async downloadBinary() {
    await super.downloadBinary(DARWIN);
  }

  getBinaryPath() {
    return this.binaryPath;
  }
}

export default DarwinHandler;
