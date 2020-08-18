const chai = require('chai');
const sinon = require('sinon');
const artifact = require('@actions/artifact');
const core = require('@actions/core');
const ArtifactsManager = require('../src/artifactsManager');

const { expect } = chai;

describe('Artifacts Handling', () => {
  let artifactClient;

  beforeEach(() => {
    artifactClient = {
      uploadArtifact: sinon.stub().returns('Response'),
    };

    sinon.stub(artifact, 'create').returns(artifactClient);
    sinon.stub(core, 'info');
  });

  afterEach(() => {
    core.info.restore();
  });

  context('Upload Artifacts', () => {
    it('by specifying the file location', () => {
      const artifactName = 'RandomName';
      const files = ['/some/path/file'];
      const rootFolder = '/some/path';
      const options = {
        continueOnError: true,
      };

      return ArtifactsManager.uploadArtifacts(artifactName, files, rootFolder)
        .then((response) => {
          sinon.assert.calledWith(
            artifactClient.uploadArtifact,
            artifactName,
            files,
            rootFolder,
            options,
          );
          sinon.assert.called(core.info);
          expect(response).to.eql('Response');
        });
    });
  });
});
