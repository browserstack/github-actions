# upload-app
This action fulfils the following objectives in your runner environment:
* Uploading the app/testsuite paths provided to browserstack
* Adding the returned app ids, to necessary environment variable for further usage

## Prerequisites
* The **actions/checkout@v2** action should be invoked prior to invoking this action as we will be using config files committed to the repo 
* The **browserstack/github-actions/setup-env@master** action should have been invoked prior to invoking this action as a part of the same job. The following are the environment variables that you can use in the test scripts.
```
APP_HASHED_ID
TEST_SUITE_ID
FRAMEWORK
```

> Note in case you plan on running an App Automate espresso or xcuitest, you can make use **browserstack/github-actions/run-tests@master** action. 

## Inputs
* `app-path`: (**Mandatory**)
  * relative path from the root of the repository to a app file. This app will be uploaded to the browserstack cloud.
* `framework`:
  * Valid Inputs:
    * espresso
    * xcuitest
  * specify which testing framework is the testSuite to uploaded is based on
* `test-suite-path`:
  * relative path from the root of the repository to a testSuite file. This testSuite will be uploaded to the browserstack cloud. 
   

## Usage
Use the code snippet below in your workflow to run a espresso framework test:
```yaml
- name: 'BrowserStack App Upload'
  uses: 'browserstack/github-actions/upload-app@master'
  with:
    app-path: ./app/build/outputs/apk/production/debug/app-production-debug.apk
    framework: espresso
    test-suite-path: ./app/build/outputs/apk/androidTest/production/debug/app-production-debug-androidTest.apk
```