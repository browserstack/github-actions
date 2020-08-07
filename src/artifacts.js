import * as artifact from '@actions/artifact';

const artifactClient = artifact.create();

/**
 * Upload artifacts to GitHub workflow
 * @param {String} artifactName Name by which the artifact should be available post uploading
 * @param {String[]} files Files to upload
 * @param {String} rootFolder Folder in which the files reside
 * @returns {artifact.UploadResponse} Response of the upload operation
 */
const uploadArtifacts = async (artifactName, files, rootFolder) => {
  const response = await artifactClient.uploadArtifact(
    artifactName,
    files,
    rootFolder, {
      continueOnError: true,
    },
  );
  console.log(`Response for upload: ${JSON.stringify(response)}`);
  return response;
};

// eslint-disable-next-line import/prefer-default-export
export { uploadArtifacts };
