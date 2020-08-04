import BaseHandler from './baseHandler';
import constants from '../../config/constants';

const { BINARY_PATHS: { DARWIN } } = constants;

class DarwinHandler extends BaseHandler {
  constructor() {
    super();
    this.platform = 'darwin';
    this.toolName = 'BrowserStackLocal';
  }

  async downloadBinary() {
    await super.downloadBinary(DARWIN);
  }

  binaryPath() {
    return this.binaryPath;
  }
}

export default DarwinHandler;
