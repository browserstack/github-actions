import * as core from '@actions/core';
import LinuxHandler from './linuxHandler';
import WindowsHandler from './winHandler';
import DarwinHandler from './darwinHandler';

const HANDLER_MAPPING = {
  linux: LinuxHandler,
  win: WindowsHandler,
  darwin: DarwinHandler,
};

class BinaryFactory {
  static getHandler(type) {
    try {
      const matchedType = type.match(/linux|darwin|win/) || [];
      const Handler = HANDLER_MAPPING[matchedType[0]];
      if (!Handler) {
        throw Error(`No Handler Found for the Platform Type: ${type}`);
      }

      return new Handler();
    } catch (e) {
      core.setFailed(`Failed in Setting Binary Factory: ${e.message}`);
    }
  }
}

export default BinaryFactory;
