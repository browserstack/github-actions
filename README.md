# BrowserStack GitHub Actions

<p align="center">
  <a href="https://browserstack.com"><img alt="BrowserStack Logo" src="https://d98b8t1nnulk5.cloudfront.net/production/images/layout/logo-invoice.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/browserstack/github-actions/actions?query=workflow%3Asetup-env"><img alt="setup-env build status" src="https://github.com/browserstack/github-actions/workflows/setup-env/badge.svg"></a>
  <a href="https://github.com/browserstack/github-actions/actions?query=workflow%3Asetup-local"><img alt="setup-local build status" src="https://github.com/browserstack/github-actions/workflows/setup-local/badge.svg"></a>
</p>

This respository contains a library of GitHub Actions to help you integrate your test suite with the [BrowserStack](https://browserstack.com) device cloud. 

You need a BrowserStack username and access-key to run your tests on the BrowserStack device cloud. You can [sign-up for free trial](https://www.browserstack.com/users/sign_up) if you do not have an existing account.

If you want to test your open source project on BrowserStack, then [sign-up here](https://www.browserstack.com/open-source) for lifetime free access to all our products.

## Available Actions
* [setup-env](./setup-env): This Action helps in setting up the required environment variables that are to be used in your test scripts. The environment variables set up here shall be used by other BrowserStack actions as well for their functioning.
  
* [setup-local](./setup-local): This Action downloads and starts the appropriate BrowserStackLocal binary, thereby creating a secure tunnel connection from the GitHub Actions runner environment to the BrowserStack device cloud. This secure tunnel will be used by the remote browsers in BrowserStack to access your web application hosted in the GitHub Actions runner environment. **You do not need this Action if the application to be tested is accessible over the public internet.**

* [upload-app](./upload-app): This Action can be used to upload you test apps and test suites to browserstack cloud, so that they can then be used to run app automate tests.

* [run-test](./run-tests): This Action can be used to run your app automate espresso and xcuitest sessions. It triggers a build based on the config file provided and based on the build result marks the github build accordingly.

## Prerequisites
* You should set your BrowserStack Username and Access Key as GitHub Secrets, i.e. `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` respectively.

## Usage
As this is a library of Actions, invoking this Action will trigger the `setup-env` Action internally. The following usage example will **only** set up the required environment variables:

```yaml
- name: BrowserStack Action
  uses: 'browserstack/github-actions@master'
  with:
    username:  ${{ secrets.BROWSERSTACK_USERNAME }}
    access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
    build-name: BUILD_INFO
    project-name: REPO_NAME
```
We recommend you to invoke the Actions individually depending on the use case. A sample workflow for the same is shown below. You can additionally refer to the individual `README` ([setup-env](./setup-env), [setup-local](./setup-local), [upload-app](./upload-app), [run-tests](./run-tests)) of the Actions to know more about how they work, the inputs they support and their usage examples.

## Sample Workflow with usage of Actions
The workflow example below would be useful when the web application to be tested is hosted on the GitHub Actions runner environment, i.e. not accessible from the public Internet.

```yaml
name: 'BrowserStack Test'
on: [push, pull_request]

jobs:
  ubuntu-job:
    name: 'BrowserStack Test on Ubuntu'
    runs-on: ubuntu-latest
    steps:
      - name: 'BrowserStack Env Setup'
        uses: 'browserstack/github-actions/setup-env@master'
        with:
          username:  ${{ secrets.BROWSERSTACK_USERNAME }}
          access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
          build-name: BUILD_INFO
          project-name: REPO_NAME
      - name: 'BrowserStackLocal Setup'
        uses: 'browserstack/github-actions/setup-local@master'
        with:
          local-testing: start
          local-identifier: random
```

## Sample Workflow for running an App Automate Build on Browserstack
```yaml
name: Browserstack session

on: [push]

jobs:
  build:
    runs-on: macos-latest

    steps:
      - name: 'BrowserStack Env Setup'
        uses: 'browserstack/github-actions/setup-env@master'
        with:
          username:  ${{ secrets.BROWSERSTACK_USERNAME }}
          access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
          build-name: "test_build"
          project-name: "test_project"
      - name: 'BrowserStack App Upload'
        uses: 'browserstack/github-actions/upload-app@beta'
        with:
          app-path: ./app/build/outputs/apk/production/debug/app-production-debug.apk
          framework: espresso
          test-suite-path: ./app/build/outputs/apk/androidTest/production/debug/app-production-debug-androidTest.apk
      - name: 'Run tests on browserstack'
        uses: 'browserstack/github-actions/run-tests@beta'
        with:
          config-path: ./.github/test_config.json
```

### Note
---
Post these steps, you will have to build and run your application web server on the same runner environment. Further, invoke your test scripts by utilizing the environment variables that have been set by actions. For more detailed steps on how to integrate your test suite with BrowserStack on GitHub Actions, visit [BrowserStack Documentation](http://browserstack.com/docs/automate/selenium/github-actions) for the same.

After you are done running your tests, invoke the `setup-local` Action again with `local-testing: stop` as the input:
```yaml
      - name: 'BrowserStackLocal Stop'
        uses: 'browserstack/github-actions/setup-local@master'
        with:
          local-testing: stop
```
## Feature requests and bug reports
Please file feature requests and bug reports as [github issues](https://github.com/browserstack/github-actions/issues).
