const sinon = require('sinon');
const core = require('@actions/core');
const fs = require('fs');
const request = require('request');
const stream = require('stream');
const Uploader = require('../src/utils');
const constants = require('../config/constants');

const {
  INPUT,
  ENV_VARS,
  URLS,
} = constants;

describe('Uploader', () => {
  let stubbedInput;
  let stubbedReadStream;
  let previousAccessKey;
  let previousLocalIdentifier;

  beforeEach(() => {
    previousAccessKey = process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY];
    previousLocalIdentifier = process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER];
    process.env[ENV_VARS.BROWSERSTACK_USERNAME] = "some_user_name";
    process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = "some_access_key";
    stubbedInput = sinon.stub(core, 'getInput');
    stubbedInput.withArgs(INPUT.APP_PATH).returns("some/random/app/path.apk");
    stubbedInput.withArgs(INPUT.FRAMEWORK).returns("espresso");
    stubbedInput.withArgs(INPUT.TEST_SUITE).returns("some/random/test/path.apk");
    sinon.stub(core, 'exportVariable');
  });

  afterEach(() => {
    process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = previousAccessKey;
    process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER] = previousLocalIdentifier;
    core.getInput.restore();
    core.exportVariable.restore();
  });

  describe('_upload', () => {
    let stubRequests;
    let mockStream;

    beforeEach(() => {
      stubRequests = sinon.stub(request, 'post');
      stubbedReadStream = sinon.stub(fs, 'createReadStream');
      mockStream = new stream.Readable();
      stubbedReadStream.withArgs('some/random/app/path.apk').returns(mockStream);
    });

    afterEach(() => {
      mockStream.destroy();
      request.post.restore();
      fs.createReadStream.restore();
    });

    it('should make upload request and set the hashed id to environment variable', () => {
      stubRequests.yields(null, {
        statusCode: 200,
        body: JSON.stringify({
          app_url: "bs://app_hashed_id",
        }),
      });
      Uploader._upload('some/random/app/path.apk', undefined, 'upload', ENV_VARS.APP_HASHED_ID);
      sinon.assert.calledWith(core.exportVariable, ENV_VARS.APP_HASHED_ID, "bs://app_hashed_id");
    });

    it('should handle upload errors', () => {
      stubRequests.yields(null, {
        statusCode: 502,
      });
      sinon.stub(core, 'setFailed');
      Uploader._upload('some/random/app/path.apk', undefined, 'upload', ENV_VARS.APP_HASHED_ID);
      sinon.assert.calledOnce(core.setFailed);
    });
  });

  describe('_run', () => {
    context('When framework and testsuite is defined', () => {
      it('should call upload function for app-path and testsuite with appropriate arguments', () => {
        const stubUpload = sinon.stub(Uploader, '_upload');
        const appUploadStub = stubUpload.withArgs("some/random/app/path.apk", undefined, URLS.APP_FRAMEWORKS.espresso, ENV_VARS.APP_HASHED_ID);
        const testSuiteUploadStub = stubUpload.withArgs("some/random/test/path.apk", undefined, URLS.TESTSUITE_FRAMEWORKS.espresso, ENV_VARS.TEST_SUITE_ID);
        Uploader.run();
        sinon.assert.calledOnce(appUploadStub);
        sinon.assert.calledOnce(testSuiteUploadStub);
        Uploader._upload.restore();
      });

      it('should call upload function for app-url and test-suite-url with appropriate arguments', () => {
        stubbedInput.withArgs(INPUT.APP_PATH).returns(undefined);
        stubbedInput.withArgs(INPUT.TEST_SUITE).returns(undefined);
        stubbedInput.withArgs(INPUT.APP_URL).returns("http://something.com");
        stubbedInput.withArgs(INPUT.TEST_SUITE_URL).returns("http://something-else.com");
        const stubUpload = sinon.stub(Uploader, '_upload');
        const appUploadStub = stubUpload.withArgs(undefined, "http://something.com", URLS.APP_FRAMEWORKS.espresso, ENV_VARS.APP_HASHED_ID);
        const testSuiteUploadStub = stubUpload.withArgs(undefined, "http://something-else.com", URLS.TESTSUITE_FRAMEWORKS.espresso, ENV_VARS.TEST_SUITE_ID);
        Uploader.run();
        sinon.assert.calledOnce(appUploadStub);
        sinon.assert.calledOnce(testSuiteUploadStub);
        Uploader._upload.restore();
      });
    });

    context('When only app is defined', () => {
      it('should call upload function with appropriate arguments', () => {
        stubbedInput.withArgs(INPUT.FRAMEWORK).returns(undefined);
        stubbedInput.withArgs(INPUT.TEST_SUITE).returns(undefined);
        const stubUpload = sinon.stub(Uploader, '_upload');
        const appUploadStub = stubUpload.withArgs("some/random/app/path.apk", undefined, URLS.APP_UPLOAD_ENDPOINT, ENV_VARS.APP_HASHED_ID);
        Uploader.run();
        sinon.assert.calledOnce(appUploadStub);
        Uploader._upload.restore();
      });
    });
  });
});
