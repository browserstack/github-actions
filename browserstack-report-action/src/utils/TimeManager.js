class TimeManager {
  constructor(timeoutSeconds) {
    this.timeoutMs = timeoutSeconds * 1000;
    this.startTime = Date.now();
  }

  checkTimeout() {
    if (Date.now() - this.startTime >= this.timeoutMs) {
      return true;
    }
    return false;
  }

  setPollingInterval(seconds) {
    this.pollingInterval = seconds;
  }

  /**
   * Sleep for specified seconds
   * @param {number} seconds - Number of seconds to sleep
   * @returns {Promise} - Promise that resolves after the specified time
   */
  async sleep() {
    return new Promise((resolve) => setTimeout(resolve, this.pollingInterval * 1000));
  }
}

module.exports = TimeManager;
