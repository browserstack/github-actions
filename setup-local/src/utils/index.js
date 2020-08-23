const core = require('@actions/core');
const tc = require('@actions/tool-cache');

class Utils {
  static clearEnvironmentVariable(environmentVariable) {
    core.exportVariable(environmentVariable, '');
    delete process.env[environmentVariable];
  }

  static checkToolInCache(toolName, version) {
    const toolCachePath = tc.find(toolName, version);
    return toolCachePath;
  }

  static async sleepFor(ms) {
    let parsedMilliseconds = parseFloat(ms);
    parsedMilliseconds = parsedMilliseconds > 0 ? parsedMilliseconds : 0;
    return new Promise((resolve) => setTimeout(resolve, parsedMilliseconds));
  }
}

module.exports = Utils;
