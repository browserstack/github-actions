import * as core from '@actions/core';
import LinuxHandler from './linuxHandler';

const HANDLER_MAPPING = {
  linux: LinuxHandler,
};

class BinaryFactory {
  static getHandler(type) {
    try {
      const matchedType = type.match(type.match(/linux|darwin|win/) || []);
      const Handler = HANDLER_MAPPING[matchedType];
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
