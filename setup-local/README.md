# setup-local
This action fulfils the following objectives in your runner environment:
* It will download the appropriate type of BrowserStackLocal binary in your runner environment depending on the environment, i.e. Linux/Darwin/Win32.
* It will start (or stop) the binary and establish (or end) the Local tunnel connection from the runner machine to the BrowserStack cloud as per the input for `local-testing` field.
* The action provides the functionality to specify the logging level of the binary and then upload the logs as artifacts in GitHub workflow.
* The action allows you to pass any combination of arguments for the invocation of the BrowserStackLocal binary as given [here](https://www.browserstack.com/local-testing/binary-params).

## Prerequisites
The **browserstack/github-actions/setup-env@master** action should have been invoked prior to invoking this action as a part of the same job.

## Inputs
* `local-testing`: (**Mandatory**)
  * Valid inputs:
    * `start`: This will download the BrowserStackLocal binary (if it wasn't downloaded earlier by this action in the same runner environment) and start the binary with additional inputs that you might provide. The `local-identifier` that is used to start the binary will be set in the environment variable `BROWSERSTACK_LOCAL_IDENTIFIER`. The same will be used for stopping the binary when using the `stop` input.
    * `stop`: This will ensure that a previously running binary will be stopped and if any log-level was set by `local-logging-level`, then the logs will be uploaded as artifacts. **If you do not stop the binary after the completion of your tests, the logs will not be uploaded as artifacts.**
* `local-logging-level`: (**Optional**)
  * Valid inputs:
    * `false`: No local binary logs will be captured.
    * `setup-logs`: Local logs to debug issues related to setting up of connections will be saved. They will be uploaded as artifacts only if the action is again invoked with `local-testing: stop`.
    * `network-logs`: Local logs related to network information will be saved. They will be uploaded as artifacts only if the action is again invoked with `local-testing: stop`.
    * `all-logs`: Local logs related to all communication to local servers for each request and response will be saved. They will be uploaded as artifacts only if the action is again invoked with `local-testing: stop`.
  * Default: `false`.
* `local-identifier`: (**Optional**)
  * Valid inputs:
    * `random`: This is the recommended value for this input. A randomly generated string will be used to start the local tunnel connection and the string will be saved in the environment variable `BROWSERSTACK_LOCAL_IDENTIFIER`. You must use the same environment variable in your test script to specify the tunnel identifier in capabilities.
    * `<string>`: You can choose any value for the `string`. The same will be saved in the environment variable `BROWSERSTACK_LOCAL_IDENTIFIER` which you must use in your test script to specify the tunnel identifier in capabilities.
  * Default: If you do not provide any input, then no tunnel identifier will be used. This option is not recommended because if multiple tunnels are created without any identifier (or with same identifier) for the same access-key, then tests might behave abnormally. It is strongly advised not to choose this option.
* `local-args`: (**Optional**)
  * Valid input: You can choose to pass any additional arguments to start the local binary through this option. All your arguments must be a part of this single string. You can find the complete list of supported local-binary arguments [here](https://www.browserstack.com/local-testing/binary-params).
  * E.g. `local-args: --force-local --proxy-host <HOST> --proxy-port <PORT> --proxy-user <USER> --proxy-pass <PASSWORD>`
  * **NOTE**: Do not include the following arguments as a part of this input string (they will be ignored if passed):
    * `--key` or `-k`
    * `--local-identifier`
    * `--daemon`
    * `--only-automate`
    * `--verbose`
    * `--log-file`
    * The above arguments are already being included in the invocation of the local binary and hence, if you include any of the above again in the `local-args` string, they will be ignored. `local-args` is an optional argument and under normal circumstances, if the application is not hosted behind any proxy, this input would not be required. Visit [this page](https://www.browserstack.com/local-testing/binary-params) to see if any additional argument is applicable to your test scenario.

## Usage
Use the code snippet below in your workflow to start the BrowserStackLocal binary and establish the tunnel connection:
```
- name: 'Start BrowserStackLocal Tunnel'
  uses: 'browserstack/github-actions/setup-local@master'
  with:
    local-testing: start
    local-logging-level: all-logs
    local-identifier: random
```

Use the code snippet below at the end of your workflow after the tests have completed. This will stop the BrowserStackLocal binary and upload the local binary logs (if any):
```
- name: 'Stop BrowserStackLocal'
  uses: 'browserstack/github-actions/setup-local@master'
  with:
    local-testing: stop
```