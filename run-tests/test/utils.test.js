const sinon = require('sinon');
const core = require('@actions/core');
const fs = require('fs');
const request = require('request');
const { expect } = require('chai');
const rewire = require('rewire');
const constants = require('../config/constants');

const TestRunner = rewire('../src/utils');

const {
  INPUT,
  ENV_VARS,
  URLS,
  TEST_STATUS,
} = constants;

const previousValues = {};

const sampleEspressoConfig = JSON.stringify({
  devices: ["Google Pixel 3-9.0", "Google Pixel 4-11.0"],
  deviceLogs: true,
  testSuite: "bs://some_test_suite_id",
  app: "bs://some_app_id",
  project: "test",
});

const sampleXcuitestConfig = JSON.stringify({
  devices: ["iphone 12-14"],
  deviceLogs: true,
  testSuite: "bs://some_test_suite_id",
  app: "bs://some_app_id",
  project: "test",
});

const cloneBackupValues = () => {
  Object.keys(ENV_VARS).forEach((key) => {
    previousValues[ENV_VARS[key]] = process.env[ENV_VARS[key]];
  });
};

const restoreOriginalValues = () => {
  Object.keys(ENV_VARS).forEach((key) => {
    process.env[ENV_VARS[key]] = previousValues[ENV_VARS[key]];
  });
};

describe('TestRunner', () => {
  let stubbedInput;
  let stubbedReadStream;

  beforeEach(() => {
    cloneBackupValues();
    process.env[ENV_VARS.BROWSERSTACK_USERNAME] = "some_user_name";
    process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = "some_access_key";
    process.env[ENV_VARS.BROWSERSTACK_PROJECT_NAME] = "sample";
    stubbedInput = sinon.stub(core, 'getInput');
    stubbedInput.withArgs(INPUT.CONFIG_PATH).returns("some/random/config.json");
    stubbedReadStream = sinon.stub(fs, 'readFileSync');
  });

  afterEach(() => {
    restoreOriginalValues();
    core.getInput.restore();
    fs.readFileSync.restore();
  });

  context('when app, testSuite and framework is not defined in the config', () => {
    it('should initialize the properties required', () => {
      process.env[ENV_VARS.APP_HASHED_ID] = "bs://some_app_id";
      process.env[ENV_VARS.TEST_SUITE_ID] = "bs://some_test_suite_id";
      process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER] = "some_random_identifier";
      process.env[ENV_VARS.FRAMEWORK] = "xcuitest";
      stubbedReadStream.withArgs("some/random/config.json").returns(JSON.stringify({
        devices: ["Google Pixel 3-9.0", "Google Pixel 4-11.0"],
        deviceLogs: true,
      }));
      const testRunner = new TestRunner();
      expect(testRunner.username).to.equal("some_user_name");
      expect(testRunner.accesskey).to.equal("some_access_key");
      expect(testRunner.config).to.deep.equal({
        app: "bs://some_app_id",
        deviceLogs: true,
        "browserstack.source": "GitHubAction",
        devices: [
          "Google Pixel 3-9.0",
          "Google Pixel 4-11.0",
        ],
        localIdentifier: "some_random_identifier",
        project: "sample",
        testSuite: "bs://some_test_suite_id",
      });
      expect(testRunner.framework).to.equal("xcuitest");
    });
  });

  context('when app, testSuite and framework is defined in the config', () => {
    it('should initialize the properties required', () => {
      process.env[ENV_VARS.APP_HASHED_ID] = "bs://some_app_id";
      process.env[ENV_VARS.TEST_SUITE_ID] = "bs://some_test_suite_id";
      process.env[ENV_VARS.BROWSERSTACK_LOCAL_IDENTIFIER] = "some_random_identifier";
      stubbedInput.withArgs(INPUT.FRAMEWORK).returns("espresso");
      stubbedReadStream.withArgs("some/random/config.json").returns(sampleEspressoConfig);
      const testRunner = new TestRunner();
      expect(testRunner.username).to.equal("some_user_name");
      expect(testRunner.accesskey).to.equal("some_access_key");
      expect(testRunner.config).to.deep.equal({
        app: "bs://some_app_id",
        deviceLogs: true,
        "browserstack.source": "GitHubAction",
        devices: [
          "Google Pixel 3-9.0",
          "Google Pixel 4-11.0",
        ],
        localIdentifier: "some_random_identifier",
        project: "test",
        testSuite: "bs://some_test_suite_id",
      });
      expect(testRunner.framework).to.equal("espresso");
    });
  });

  describe('_startBuild', () => {
    let stubRequests;

    beforeEach(() => {
      stubRequests = sinon.stub(request, 'post');
    });

    afterEach(() => {
      request.post.restore();
    });

    context('for espresso', () => {
      it('should start a build', (done) => {
        stubbedInput.withArgs(INPUT.FRAMEWORK).returns("espresso");
        stubbedReadStream.withArgs("some/random/config.json").returns(sampleEspressoConfig);

        stubRequests.withArgs(sinon.match.has('url', `https://some_user_name:some_access_key@${URLS.BASE_URL}/${URLS.FRAMEWORKS.espresso}`)).yields(null, {
          statusCode: 200,
          body: JSON.stringify({
            message: "Success",
            build_id: "random_espresso_build_id",
          }),
        });
        const testRunner = new TestRunner();
        testRunner._startBuild().then(() => {
          expect(testRunner.build_id).to.equal("random_espresso_build_id");
          done();
        });
      });
    });

    context('for xcuitest', () => {
      it('should start a build', (done) => {
        stubbedInput.withArgs(INPUT.FRAMEWORK).returns("xcuitest");
        stubbedReadStream.withArgs("some/random/config.json").returns(sampleXcuitestConfig);

        stubRequests.withArgs(sinon.match.has('url', `https://some_user_name:some_access_key@${URLS.BASE_URL}/${URLS.FRAMEWORKS.xcuitest}`)).yields(null, {
          statusCode: 200,
          body: JSON.stringify({
            message: "Success",
            build_id: "random_xcuitest_build_id",
          }),
        });
        const testRunner = new TestRunner();
        testRunner._startBuild().then(() => {
          expect(testRunner.build_id).to.equal("random_xcuitest_build_id");
          done();
        });
      });
    });
  });

  describe('_pollBuild', () => {
    let stubRequests;

    beforeEach(() => {
      stubRequests = sinon.stub(request, 'get');
      TestRunner.__set__('WATCH_INTERVAL', 10);
      sinon.stub(TestRunner, '_parseApiResult');
    });

    afterEach(() => {
      request.get.restore();
      TestRunner._parseApiResult.restore();
    });

    it('should keep polling mark build failed if tests fail', (done) => {
      stubbedReadStream.withArgs("some/random/config.json").returns(sampleEspressoConfig);
      const testRunner = new TestRunner();
      stubRequests.onCall(0).yields(null, {
        statusCode: 200,
        body: JSON.stringify({
          status: TEST_STATUS.RUNNING,
        }),
      });
      stubRequests.onCall(1).yields(null, {
        statusCode: 200,
        body: JSON.stringify({
          status: TEST_STATUS.FAILED,
        }),
      });
      testRunner._pollBuild().then(() => {
        expect(testRunner.build_status).to.equal(TEST_STATUS.FAILED);
        done();
      });
    });

    it('should keep polling mark build failed if tests passed', (done) => {
      stubbedReadStream.withArgs("some/random/config.json").returns(sampleXcuitestConfig);
      const testRunner = new TestRunner();
      stubRequests.onCall(0).yields(null, {
        statusCode: 200,
        body: JSON.stringify({
          status: TEST_STATUS.RUNNING,
        }),
      });
      stubRequests.onCall(1).yields(null, {
        statusCode: 200,
        body: JSON.stringify({
          status: TEST_STATUS.PASSED,
        }),
      });
      testRunner._pollBuild().then(() => {
        expect(testRunner.build_status).to.equal(TEST_STATUS.PASSED);
        done();
      });
    });
  });
});
describe('_uploadResults', () => {
  let stubRequests;
  beforeEach(() => {
    process.env[ENV_VARS.BROWSERSTACK_USERNAME] = "some_user_name";
    process.env[ENV_VARS.BROWSERSTACK_ACCESS_KEY] = "some_access_key";
    process.env[ENV_VARS.BROWSERSTACK_PROJECT_NAME] = "sample";
    stubRequests = sinon.stub(request, 'get');
  });

  afterEach(() => {
    request.get.restore();
    if (fs.existsSync('./reports')) {
      fs.rmSync('./reports', { recursive: true, force: true });
    }
  });

  context('for espresso', () => {
    it('should download reports', (done) => {
      const responseJson = JSON.parse(fs.readFileSync('./test/fixtures/build_response.json'));
      stubRequests.yields(null, {
        statusCode: 200,
        body: fs.readFileSync('./test/fixtures/espresso-result.xml'),
      });
      TestRunner._uploadResults(responseJson).then(() => {
        const files = fs.readdirSync('./reports');
        expect(files.length).to.be.equal(3);
        done();
      }).catch(done);
    });
  });

  context('for xcuitest', () => {
    it('should download reports', (done) => {
      const responseJson = JSON.parse(fs.readFileSync('./test/fixtures/build_response_xcuitest.json'));
      stubRequests.yields(null, {
        statusCode: 200,
        body: fs.readFileSync('./test/fixtures/xcuitest-result.zip'),
      });
      TestRunner._uploadResults(responseJson).then(() => {
        const files = fs.readdirSync('./reports');
        expect(files.length).to.be.equal(2);
        done();
      }).catch(done);
    });
  });
});
describe('_parseApiResult', () => {
  it('should parse rest api results and populate array', () => {
    const responseJson = JSON.parse(fs.readFileSync('./test/fixtures/build_response.json'));
    const returnedResult = TestRunner._parseApiResult(responseJson);
    const expectedResult = [
      [
        'Samsung Galaxy S20',
        '10.0',
        '4fc55a08d7e33651d962ad676c7d6a0a08902702',
        'failed',
        9,
        3,
        6,
      ],
      [
        'OnePlus 7',
        '9.0',
        '1f5c3cb7d1f7560635f6c83eafe418a2fabbef0d',
        'failed',
        9,
        3,
        6,
      ],
      [
        'Google Pixel 3',
        '9.0',
        'a8760f7f5fd21f73673060d4047899e6a94d9e6',
        'failed',
        9,
        3,
        6,
      ],
    ];
    expect(returnedResult).to.deep.equal(expectedResult);
  });

  it('should parse rest api results and return empty in case of no session created', () => {
    const responseJson = JSON.parse(fs.readFileSync('./test/fixtures/empty_response.json'));
    // eslint-disable-next-line no-unused-expressions
    expect(TestRunner._parseApiResult(responseJson)).to.be.undefined;
  });
});
