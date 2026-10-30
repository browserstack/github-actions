# test-companion

Ask BrowserStack Test Companion for test work from a pull request.

Comment `@test-companion test this PR` and it reads the change, proposes the
tests it would write, and writes them once someone replies `go`. The result
comes back as one comment and one check.

## Quick start

Two secrets — `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` — and the
workflow below at `.github/workflows/test-companion.yml`. Copy it as-is; what
runs is decided by `testcompanion-pipeline.yml` in your repository, not here.

```yaml
name: Test Companion

on:
    issue_comment:
        types: [created]
    pull_request:
        types: [opened, reopened, synchronize, closed]

jobs:
    test-companion:
        runs-on: ubuntu-latest
        timeout-minutes: 35
        permissions:
            contents: write # branches and commits
            pull-requests: write # the comment
            checks: write # the "Test Companion" check
            actions: write # stopping a run on request
        steps:
            - uses: actions/checkout@v4
              with:
                  fetch-depth: 0 # jobs that look at what changed need history

            - uses: browserstack/github-actions/test-companion@v1
              with:
                  username: ${{ secrets.BROWSERSTACK_USERNAME }}
                  access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
```

## Pin the CLI version

`cli-version` is optional and you should set it once you know which version you
want.

Without a pin the CLI upgrades itself the first time it runs on a release day.
That spends your pipeline's time on a download, and it means two runs a day
apart are not the same software.

**Both lines or neither.** A version with no checksum is refused — "refusing an
unverified pinned install" — and the job stops before it reports anything. Take
both from the release you tested with.

```yaml
                  cli-version: "1.2.0"
                  cli-sha256: "<sha256 of that release for linux-amd64>"
```

## Inputs

| Input | Required | What it does |
|---|---|---|
| `username` | yes | BrowserStack username, from your secret store |
| `access-key` | yes | BrowserStack access key, from your secret store |
| `cli-version` | no | Pin the CLI. Strongly recommended — see above |
| `cli-sha256` | no | Checksum for the pinned version |
| `build-effect` | no | `off`, `report` or `fail` — whether a test failure fails your build |
| `workflow` | no | Manual runs only; event-driven runs read the pipeline file |
| `preview` | no | Report what would happen and change nothing |
| `app-id` / `app-private-key` | no | Use the Test Companion GitHub App's identity |

## What runs is not decided here

This file is awkward to change once it is in many repositories, so it stays
near-empty on purpose. Which jobs run, on which events, with which spending
limits, lives in `testcompanion-pipeline.yml` in your own repository, which you
can edit freely without touching the workflow above.

## Notes for maintainers

This is a **composite** action with **no dependencies** and no `dist/` bundle to
rebuild — unlike the JavaScript actions elsewhere in this repository. The
sources in `src/` are what run.

Tests: `cd test-companion && node --test`. They need no network and no
credentials.
