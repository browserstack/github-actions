const { DefaultArtifactClient } = require('@actions/artifact');
const core = require('@actions/core');

class ArtifactsManager {
  /**
   * Upload artifacts to GitHub workflow
   * @param {String} artifactName Name by which the artifact should be available post uploading
   * @param {String[]} files Files to upload
   * @param {String} rootFolder Folder in which the files reside
   * @returns {Promise<import('@actions/artifact').UploadArtifactResponse>} =>
   * Response of the upload operation
   */
  static async uploadArtifacts(artifactName, files, rootFolder) {
    const artifactClient = new DefaultArtifactClient();
    const response = await artifactClient.uploadArtifact(
      artifactName,
      files,
      rootFolder,
      { continueOnError: true },
    );
    core.info(`Response for upload: ${JSON.stringify(response)}`);
    return response;
  }
}

// eslint-disable-next-line import/prefer-default-export
module.exports = ArtifactsManager;
