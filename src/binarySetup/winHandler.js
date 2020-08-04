import BaseHandler from './baseHandler';
import constants from '../../config/constants';

const { BINARY_PATHS: { WINDOWS } } = constants;

class WindowsHandler extends BaseHandler {
  constructor() {
    super();
    this.platform = 'windows';
    this.toolName = 'BrowserStackLocal';
  }

  async downloadBinary() {
    await super.downloadBinary(WINDOWS);
  }
}

export default WindowsHandler;
