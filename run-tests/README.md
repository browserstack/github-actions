# run-tests
This action fulfils the following objectives in your runner environment:
* It will trigger an espresso/xcuitest build, display the unique build_id for the triggered build
* Wait till the all the tests in the build gets completed, get the results of the build
* Display the result in the console and mark the build as failed or passed as per the build status on browserstack

## Prerequisites
* The **actions/checkout@v2** action should be invoked prior to invoking this action as we will be referencing confing files commited to the repo 
* The **browserstack/github-actions/setup-env@master** action should have been invoked prior to invoking this action as a part of the same job.

## Inputs
* `config-path`: (**Mandatory**)
  * relative path from the root of the repository to a json file. This json file will have all the configurations need to run the test's. like device to run the test on, app, testSuite and other capabilites. you can find the extensive list of capabilties, that can be added to config here: https://www.browserstack.com/docs/app-automate/api-reference/espresso/builds#execute-a-build
* `framework`:
  * Valid Inputs:
    * espresso
    * xcuitest
  * specify which testing framework is the test based on

> Note: In case you are using this action along with **browserstack/github-actions/upload-app@master** you need not specify app and test_suite in the config and framework in the inputs. It will the automatically picked from the previous steps outputs.  
   

## Usage
Use the code snippet below in your workflow to run a espresso framework test:
```yaml
- name: 'Run Espresso Test on Browserstack'
  uses: 'browserstack/github-actions/run-tests@master'
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