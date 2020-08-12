const { expect } = require('chai');
const InputValidator = require('../../src/actionInput/inputValidator');

describe('InputValidator class to validate individual fields of the action input', () => {
  context('Public Static Methods', () => {
    context('Validates Username', () => {
      it("Returns the username with '-GitHubAction' suffix", () => {
        const inputUsername = 'someUsername';
        expect(InputValidator.validateUsername(inputUsername)).to.eq(`${inputUsername}-GitHubAction`);
      });
    });
  });
});
