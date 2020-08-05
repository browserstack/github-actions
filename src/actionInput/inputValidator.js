class InputValidator {
  static validateUsername(inputUsername) {
    return `${inputUsername}-GitHubAction`;
  }

  static validateBuildName(inputBuildName) {
    if (inputBuildName) {
      const buildNameWithHyphen = inputBuildName.split().join('-');
      const prIndex = buildNameWithHyphen.indexOf('PR#');
      if (prIndex === -1) return buildNameWithHyphen;

      if (prIndex === 0) {
        
      }
    } else {

    }
  }
}

export default InputValidator;
