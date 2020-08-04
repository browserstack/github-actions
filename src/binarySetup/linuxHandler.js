import BaseHandler from './baseHandler';
import constants from '../../config/constants';

const { BINARY_PATHS: { LINUX } } = constants;

class LinuxHandler extends BaseHandler {
  async downloadBinary() {
    await super.downloadBinary(LINUX);
  }
}

export default LinuxHandler;
