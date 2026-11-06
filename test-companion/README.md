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

**Runner requirements:** a Linux runner (GitHub's `ubuntu-latest` works as is)
with Node 20 or later, the `gh` command installed system-wide (in `/usr/bin` or
`/usr/local/bin`), and password-free `sudo` for the job.

`sudo` is what keeps your tokens away from the AI agent. Test Companion runs
the agent as a separate user with no admin rights, which cannot read this
job's tokens, secrets or temp files. Its `gh` can only read from GitHub,
through a relay; every write (saving tests, opening a pull request) is made by
the Action itself after the run. On a runner without password-free `sudo` the
run stops and says why, unless you set `allow-unisolated: true`.

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
      - uses: browserstack/github-actions/test-companion@v1.1.0
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
| `allow-unisolated` | no | `"true"` runs the agent as the job's own user when it cannot be locked down. It can then reach this job's tokens and secrets. Off by default |
| `app-id` / `app-private-key` | no | Use the GitHub App's identity. Keep the workflow's `permissions:` block anyway: the workflow token is still the fallback |

## Approving a plan

Before a job changes anything, Test Companion posts its plan and waits for
someone with write access to reply `go`. Read the plan before you reply.

Without the GitHub App, Test Companion posts as `github-actions[bot]`, the same
account every other workflow in your repository uses. It can only recognise its
own plans by that account and a hidden marker. So a different workflow that
copies outside text into a comment could imitate a plan. A reply of `go` only
ever approves a plan for the pull request's current commit. With the App, Test
Companion posts under its own account, which no other workflow can use.

## How the CLI is installed

Each run downloads the CLI installer from
`test-companion.browserstack.com/cli/install.sh`. The installer script itself
is not checked against a fixed checksum, so a run trusts that address. Pinning
`cli-version` with `cli-sha256` (above) makes the installer refuse any CLI
build other than the one you tested.

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
