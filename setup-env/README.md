# setup-env

This action sets up the following environment variables in the runner environment. These environment variables shall be used in the tests for BrowserStack:

1. `BROWSERSTACK_BUILD_NAME`: This environment variable is set on the basis of the input to `build-name` field. By default, the value will be decided based on the event, i.e. push, pull_request etc for the workflow:
   1. `push` event: `[<Branch-Name>] Commit <commit-sha>: <commit-message> [Workflow: <Workflow-number>]`
   2. `pull_request` event: `[<Branch-Name>] PR <PR-number>: <PR-title> [Workflow-number]`
   3. `release` event: `[<Branch-Name>] Release <Release-tag>: <Release-name> [Workflow-number]`
   4. Other events: `<Event-Name> [Workflow: <Workflow-number>]`

2. `BROWSERSTACK_PROJECT_NAME`: This environment variable is set one basis of the input to `project-name` field. By default, i.e. if any input is not provided, the value will be set as the Repository Name.
3. `BROWSERSTACK_USERNAME`: This environment variable's value is taken from the input to `username` field. Ideal way would be to pass the GitHub Secret as the input, i.e. `username: ${{ secrets.BROWSERSTACK_USERNAME }}`.
4. `BROWSERSTACK_ACCESS_KEY`: This environment variable's value is taken from the input to `access-key` field. Ideal way would be to pass the GitHub Secret as the input, i.e. `access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}`.

## Prerequisites
* This action does not have any prerequisites.

## Usage
```
- name: 'BrowserStack Env Setup'
        uses: 'browserstack/github-actions/setup-env@master'
        with:
          username:  ${{ secrets.BROWSERSTACK_USERNAME }}
          access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
          build-name: BUILD_INFO
          project-name: REPO_NAME
```

or

```
- name: 'BrowserStack Env Setup'
        uses: 'browserstack/github-actions/setup-env@master'
        with:
          username:  ${{ secrets.BROWSERSTACK_USERNAME }}
          access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
```

## Inputs
* `username`: (**Mandatory**) This is your BrowserStack Username. This should ideally be passed via a GitHub Secret as shown in the sample workflow above.
* `access-key`: (**Mandatory**) This is your BrowserStack Access key that is required to access the BrowserStack device cloud. This should also ideally be passed via a GitHub Secret as shown in the sample workflow above.
* `build-name`: (**Optional**)
  * You can pass any string that you want to set as the `BROWSERSTACK_BUILD_NAME`. E.g. `build-name: My Build Name Goes Here`.
  * You can also include your personalized string along with the keyword `BUILD_INFO` in the input:
    * `build-name: My String Goes Here - BUILD_INFO`
    * `build-name: BUILD_INFO - My String at the end`
    * `build-name: String at the Beginning - BUILD_INFO - String at the end`
  * The keyword `BUILD_INFO` will be replaced by the information based on the event of the workflow as described above for `BROWSERSTACK_BUILD_NAME` environment variable.
* `project-name`: (**Optional**)
  * You can pass any string that you want to set as the `BROWSERSTACK_PROJECT_NAME`. E.g. `project-name: My Project Name Goes Here`.
  * You can also pass the keywork `REPO_NAME` as the input. This will set the Repository Name for the `BROWSERSTACK_PROJECT_NAME` environment variable.
  * If no input is provided, `REPO_NAME` will be considered as the default input.

---
**NOTE**
* This action is a prerequisite for any other BrowserStack related actions.
* This action should be invoked prior to the execution of tests on BrowserStack to be able to utilise the environment variables in your tests.
* You have to use the environment variables set by this action in your test script.
---