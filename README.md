# BrowserStack GitHub Actions

<p align="center">
  <a href="https://www.browserstack.com/?utm_source=github&utm_medium=partnered"><img alt="BrowserStack Logo" src="https://d98b8t1nnulk5.cloudfront.net/production/images/layout/logo-invoice.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/browserstack/github-actions/actions?query=workflow%3Asetup-env"><img alt="setup-env build status" src="https://github.com/browserstack/github-actions/workflows/setup-env/badge.svg"></a>
  <a href="https://github.com/browserstack/github-actions/actions?query=workflow%3Asetup-local"><img alt="setup-local build status" src="https://github.com/browserstack/github-actions/workflows/setup-local/badge.svg"></a>
</p>

This respository contains a library of GitHub Actions to help you integrate your test suite with the [BrowserStack](https://www.browserstack.com/?utm_source=github&utm_medium=partnered) device cloud. 

You need a BrowserStack username and access-key to run your tests on the BrowserStack device cloud. You can [sign-up for free trial](https://www.browserstack.com/users/sign_up/?utm_source=github&utm_medium=partnered) if you do not have an existing account.

If you want to test your open source project on BrowserStack, then [sign-up here](https://www.browserstack.com/open-source/?utm_source=github&utm_medium=partnered) for lifetime free access to all our products.

## Available Actions
* [setup-env](./setup-env): This Action helps in setting up the required environment variables that are to be used in your test scripts. The environment variables set up here shall be used by other BrowserStack actions as well for their functioning.
  
* [setup-local](./setup-local): This Action downloads and starts the appropriate BrowserStackLocal binary, thereby creating a secure tunnel connection from the GitHub Actions runner environment to the BrowserStack device cloud. This secure tunnel will be used by the remote browsers in BrowserStack to access your web application hosted in the GitHub Actions runner environment. **You do not need this Action if the application to be tested is accessible over the public internet.**

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
We recommend you to invoke the Actions individually depending on the use case. A sample workflow for the same is shown below. You can additionally refer to the individual `README` ([setup-env](./setup-env), [setup-local](./setup-local)) of the Actions to know more about how they work, the inputs they support and their usage examples.

## Sample Workflow with usage of both Actions
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

### Note
---
Post these steps, you will have to build and run your application web server on the same runner environment. Further, invoke your test scripts by utilizing the environment variables that have been set by actions. For more detailed steps on how to integrate your test suite with BrowserStack on GitHub Actions, visit [BrowserStack Documentation](https://www.browserstack.com/docs/automate/selenium/github-actions/?utm_medium=partnered&utm_source=github) for the same.

After you are done running your tests, invoke the `setup-local` Action again with `local-testing: stop` as the input:
```yaml
      - name: 'BrowserStackLocal Stop'
        uses: 'browserstack/github-actions/setup-local@master'
        with:
          local-testing: stop
```
## Feature requests and bug reports
Please file feature requests and bug reports as [github issues](https://github.com/browserstack/github-actions/issues).
