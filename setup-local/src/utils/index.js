const tc = require('@actions/tool-cache');

class Utils {
  static clearEnvironmentVariable(environmentVariable) {
    delete process.env[environmentVariable];
  }

  static checkToolInCache(toolName) {
    const toolCache = tc.findAllVersions(toolName);
    return toolCache.length !== 0;
  }
}

module.exports = Utils;
