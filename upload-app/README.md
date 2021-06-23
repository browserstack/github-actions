# upload-app
This action fulfils the following objectives in your runner environment:
* Uploading the app/testsuite paths provided to browserstack
* Adding the returned app ids, to necessary environment variable for further usage

The following are the environment variables intialised by action, that you can use in the test scripts.
```
BROWSERSTACK_APP_HASHED_ID
BROWSERSTACK_TEST_SUITE_ID
BROWSERSTACK_FRAMEWORK
```

## Prerequisites
* The **actions/checkout@v2** action should be invoked prior to invoking this action as we will be using config files committed to the repo 
* The **browserstack/github-actions/setup-env@master** action should have been invoked prior to invoking this action as a part of the same job. 

> Note in case you plan on running an App Automate espresso or xcuitest, you can make use **browserstack/github-actions/run-tests@beta** action. 

## Inputs
* `app-path`:
  * relative path from the root of the repository to a app file. This app will be uploaded to the browserstack cloud.
* `app-url`:
  * remote URL to your app. Ensure that its a publicly accessible URL as BrowserStack will attempt to download the app from this location. Either file or url parameter is required.
* `app-custom-id`:
  * custom ID for the app. Refer to our [custom ID](https://www.browserstack.com/docs/app-automate/appium/upload-app-define-custom-id) documentation to know more. 
* `framework`:
  * Valid Inputs:
    * espresso
    * xcuitest
  * specify which testing framework is the testSuite to uploaded is based on
* `test-suite-path`:
  * relative path from the root of the repository to a testSuite file. This testSuite will be uploaded to the browserstack cloud. 
* `test-suite-url`:
  * remote URL to your test suite. Ensure that its a publicly accessible URL as BrowserStack will attempt to download the app from this location.
* `test-suite-custom-id`:
  * custom ID for the test-suite. Refer to our [custom ID](https://www.browserstack.com/docs/app-automate/appium/upload-app-define-custom-id) documentation to know more. 
   

## Usage
Use the code snippet below in your workflow to run a espresso framework test:
```yaml
- name: 'BrowserStack App Upload'
  uses: 'browserstack/github-actions/upload-app@beta'
  with:
    app-path: ./app/build/outputs/apk/production/debug/app-production-debug.apk
    framework: espresso
    test-suite-path: ./app/build/outputs/apk/androidTest/production/debug/app-production-debug-androidTest.apk
```

Use the code snippet below in your workflow to upload app using public url with custom id:
```yaml
- name: 'BrowserStack App Upload'
  uses: 'browserstack/github-actions/upload-app@beta'
  with:
    app-url: http://testci.something.com/download/staging_debug.ipa
    app-custom-id: staging_debug_app 
```
