const chai = require('chai');
const sinon = require('sinon');
const { DefaultArtifactClient } = require('@actions/artifact');
const ArtifactsManager = require('../src/artifactsManager');

const { expect } = chai;

describe('Artifacts Handling', () => {
  let artifactClientStub;

  beforeEach(() => {
    artifactClientStub = sinon.createStubInstance(DefaultArtifactClient);
    artifactClientStub.uploadArtifact.resolves('Response');

    sinon.stub(ArtifactsManager, 'uploadArtifacts').callsFake((artifactName, files, rootFolder) => artifactClientStub.uploadArtifact(artifactName,
      files,
      rootFolder,
      { continueOnError: true }));
  });

  afterEach(() => {
    sinon.restore();
  });

  context('Upload Artifacts', () => {
    it('by specifying the file location', async () => {
      const artifactName = 'RandomName';
      const files = ['/some/path/file'];
      const rootFolder = '/some/path';
      const options = { continueOnError: true };

      const response = await ArtifactsManager.uploadArtifacts(artifactName, files, rootFolder);

      sinon.assert.calledWith(artifactClientStub.uploadArtifact,
        artifactName,
        files,
        rootFolder,
        options);

      expect(response).to.eql('Response');
    });
  });
});
