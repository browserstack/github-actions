const core = require('@actions/core');
const tc = require('@actions/tool-cache');

class Utils {
  static clearEnvironmentVariable(environmentVariable) {
    core.exportVariable(environmentVariable, '');
    delete process.env[environmentVariable];
  }

  static checkToolInCache(toolName, version) {
    const toolCachePath = tc.find(toolName, version);
    console.dir(process.env.PATH);
    console.dir(toolCachePath);
    return toolCachePath;
  }
}

module.exports = Utils;
