# run-tests
This action fulfils the following objectives in your runner environment:
* It will trigger an espresso/xcuitest build, display the unique build_id for the triggered build
* Wait till the all the tests in the build gets completed, get the results of the build
* Display the result in the console and mark the build as failed or passed as per the build status on browserstack

## Prerequisites
* The **actions/checkout@v3** action should be invoked prior to invoking this action as we will be referencing confing files commited to the repo 
* The **browserstack/github-actions/setup-env@master** action should have been invoked prior to invoking this action as a part of the same job.

## Inputs
* `config-path`: (**Mandatory**)
  * relative path from the root of the repository to a json file. This json file will have all the configurations need to run the test's. like device to run the test on, app, testSuite and other capabilites. you can find the extensive list of capabilties, that can be added to config here: [espresso](https://www.browserstack.com/docs/app-automate/api-reference/espresso/builds#execute-a-build) [xcuitest](https://www.browserstack.com/docs/app-automate/api-reference/xcuitest/builds#execute-a-build)
* `framework`:
  * Valid Inputs:
    * espresso
    * xcuitest
  * specify which testing framework is the test based on
* `async`:
  * Valid Inputs:
    * true
    * false
  * default: 
    * false, in case this param isn't passed by default the build will wait for the test to get completed
  * specify if the test need to run in background and not poll for results, useful in case of long running test cases. The action will be marked as passed as soon as build is started independent of result.
* `upload`:
  * Valid Inputs:
    * true
    * false
  * default: 
    * false, in case this param isn't passed reports will not be uploaded to artifacts.
  * specify if you want to upload test reports to artifacts.

> Note: In case you are using this action along with **browserstack/github-actions/upload-app@beta** you need not specify app and test_suite in the config and framework in the inputs. It will the automatically picked from the previous steps outputs.  
   

## Usage
Use the code snippet below in your workflow to run a espresso framework test:
```yaml
- name: 'Run Test on Browserstack'
  uses: 'browserstack/github-actions/run-tests@beta'
  with:
    config-path: ./config/test_config.json
    framework: espresso
```
The `test_config.json` file can be something like:
```json
{
  "app": "app_url_from_browserstack",
  "testSuite": "testsuite_url_from_browserstack",
  "devices":["Google Pixel 3-9.0", "Google Pixel 4-11.0"],
  "deviceLogs":true,
  "project": "browserstack-github-actions"
}
```


## Sample Usecases
### Build android app with gradle, upload it to browserstack and run espresso test
  * config (test_config.json)
  ```json
  {
    "devices":["Google Pixel 3-9.0", "Google Pixel 4-11.0"],
    "deviceLogs":true,
    "locale":"fr_CA",
    "project": "browserstack-github-actions"
  }
  ```
  > note in the above sample app and test urls are specified they will be picked directly from upload step from the workflow
  * github workflow
  ```yml
  name: Java Browserstack CI
  on: [push]

  jobs:
    build:
      runs-on: macos-latest

      steps:
        # this is needed so that github action can access the files in the repo like config, app etc 
        - uses: actions/checkout@v3

        # following are the steps to build app and test suite
        - name: Set up JDK 14
          uses: actions/setup-java@v3
          with:
            java-version: '14'
            distribution: 'adopt'
        - name: Build App gradle
          run: ./gradlew assemble
        - name: Build Test App gradle
          run: ./gradlew assembleAndroidTest
        
        # setup browserstack credentials
        # picks up `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` from secrets 
        - name: 'BrowserStack Env Setup'
          uses: 'browserstack/github-actions/setup-env@master'
          with:
            username:  ${{ secrets.BROWSERSTACK_USERNAME }}
            access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
            build-name: "test_build"
            project-name: "test_project"
        
        # uploads app and testsuite from paths where the gradle build created the output apks 
        - name: 'BrowserStack App Upload'
          uses: 'browserstack/github-actions/upload-app@beta'
          with:
            app-path: ./app/build/outputs/apk/production/debug/app-production-debug.apk
            framework: espresso
            test-suite-path: ./app/build/outputs/apk/androidTest/production/debug/app-production-debug-androidTest.apk
        
        # runs espresso test on browserstack
        # config path is relative to the root of the repository
        - name: 'Run tests on browserstack'
          uses: 'browserstack/github-actions/run-tests@beta'
          with:
            config-path: ./.github/test_config.json
  ```

### Use existing uploaded xcuitest app and test suite, run it with local testing feature
  * config (test_config.json)
  ```json
  {
    "devices":["iPhone XS-13", "iPhone SE 2020-13", "iPhone XR-12"],
    "app":"bs://17bef856c324efff366a3a7516d758e19fc19e9c",
    "testSuite":"bs://9bbace1db07ff116e36a2726591e963799f2288f",
    "local": true,
    "locale":"fr_CA",
    "setEnvVariables": {"linkTextToVerify":"Log In","URL":"https://facebook.com"},
    "project": "browserstack-github-actions"
  }
  ```
  > note in the above config local identifier will be picked directly from the previous steps, so need not specify it explicitly
  * github workflow
  ```yml
  name: Run Local Test On Browserstack CI
  on: [push]

  jobs:
    build:
      runs-on: macos-latest

      steps:
        # this is needed so that github action can access the files in the repo like config, app etc 
        - uses: actions/checkout@v3
        
        # setup browserstack credentials
        # picks up `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` from secrets 
        - name: 'BrowserStack Env Setup'
          uses: 'browserstack/github-actions/setup-env@master'
          with:
            username:  ${{ secrets.BROWSERSTACK_USERNAME }}
            access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
            build-name: "test_build"
            project-name: "test_project"
        
        # start local binary
        - name: 'Start BrowserStackLocal Tunnel'
          uses: 'browserstack/github-actions/setup-local@master'
          with:
            local-testing: start
            local-logging-level: all-logs
            local-identifier: random
        
        # runs xcuitest test on browserstack
        # config path is relative to the root of the repository
        - name: 'Run tests on browserstack'
          uses: 'browserstack/github-actions/run-tests@beta'
          with:
            config-path: ./.github/test_config.json
            framework: xcuitest

        # stop local binary
        - name: 'BrowserStackLocal Stop' 
          uses: browserstack/github-actions/setup-local@master
          with:
            local-testing: stop
  ```
