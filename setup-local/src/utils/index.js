const core = require('@actions/core');
const tc = require('@actions/tool-cache');

class Utils {
  static clearEnvironmentVariable(environmentVariable) {
    core.exportVariable(environmentVariable, '');
    delete process.env[environmentVariable];
  }

  static checkToolInCache(toolName) {
    const toolCache = tc.findAllVersions(toolName);
    console.dir(toolCache);
    return toolCache.length !== 0;
  }
}

module.exports = Utils;
