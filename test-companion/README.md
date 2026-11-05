# test-companion

Ask BrowserStack Test Companion for test work from a pull request.

Comment `@browserstack test this PR` and it reads the change, proposes the
tests it would write, and writes them once someone replies `go`. The result
comes back as one comment and one check.

## Quick start

1. Add two secrets: `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY`.
2. Copy [`starter-workflow.yml`](starter-workflow.yml) to
   `.github/workflows/test-companion.yml` in your repository, as-is.

What runs is decided by `testcompanion-pipeline.yml` in your repository, not by
the workflow file.

Use the starter file itself rather than writing your own. Besides the triggers,
it carries safeguards that are easy to leave out:

- a filter that skips comments not meant for Test Companion, so they don't start
  a job;
- `persist-credentials: false` on checkout, so the workflow token is not left in
  `.git/config` where commands the agent runs could read it;
- the concurrency rules that keep one run per pull request, and let closing a
  pull request cancel its run.

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
      - uses: browserstack/github-actions/test-companion@v1
        with:
          username: ${{ secrets.BROWSERSTACK_USERNAME }}
          access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
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
| `build-effect` | no | Whether this step goes red. `fail-on-break` (the default) only when the run itself broke, could not start or hit a limit, not when tests failed. `report` never. `fail` on anything that is not a success, test failures included. The Test Companion check always reports truthfully either way |
| `workflow` | no | Manual runs only; event-driven runs read the pipeline file |
| `preview` | no | Report what would happen and change nothing |
| `app-id` / `app-private-key` | no | Use the Test Companion GitHub App's identity |

## Approving a plan

Before a job changes anything, Test Companion posts its plan and waits for
someone with write access to reply `go`. Read the plan before you reply.

Without the GitHub App, Test Companion posts as `github-actions[bot]`, the same
account every other workflow in your repository uses. It can only recognise its
own plans by that account and a hidden marker. So a different workflow that
copies outside text into a comment could imitate a plan. A reply of `go` only
ever approves a plan for the pull request's current commit. With the App, Test
Companion posts under its own account, which no other workflow can use.

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
