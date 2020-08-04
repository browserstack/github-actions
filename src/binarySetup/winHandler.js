import * as path from 'path';
import BaseHandler from './baseHandler';
import constants from '../../config/constants';

const { BINARY_PATHS: { WINDOWS }, LOCAL_BINARY_FOLDER } = constants;

class WindowsHandler extends BaseHandler {
  constructor() {
    super();
    this.platform = 'windows';
    this.toolName = 'BrowserStackLocal';
    this.binaryFolder = path.resolve(process.env.GITHUB_WORKSPACE, '..', '..', 'work', 'executables', LOCAL_BINARY_FOLDER, this.platform);
  }

  async downloadBinary() {
    await super.downloadBinary(WINDOWS);
  }

  getBinaryPath() {
    return this.binaryPath;
  }
}

export default WindowsHandler;
