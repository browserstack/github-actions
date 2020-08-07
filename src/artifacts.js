import * as artifact from '@actions/artifact';

const artifactClient = artifact.create();

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
