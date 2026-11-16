# test-companion

Ask BrowserStack Test Companion for test work from a pull request.

Comment `@browserstack test this PR` and it reads the change, proposes the
tests it would write, and writes them once someone replies `go`. Each request
(an `@browserstack` comment, or a `go`) gets its own reply with that run's
report, plus a "Test Companion" check. Automatic runs, which answer no
request, keep one status comment per pull request up to date.

## Quick start

1. Add two secrets: `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY`.
2. Copy [`starter-workflow.yml`](starter-workflow.yml) to
   `.github/workflows/test-companion.yml` in your repository, as-is.

Which jobs run, on which events and with which limits is set in
`testcompanion-pipeline.yml` in your repository, not in the workflow file.

**Runner requirements:** Linux (GitHub's `ubuntu-latest` works as is), Node 20
or later, `gh` installed system-wide (`/usr/bin` or `/usr/local/bin`), and
password-free `sudo` for the job.

`sudo` keeps your tokens away from the AI agent. The agent runs as a separate
user with no admin rights that cannot read this job's tokens, secrets or temp
files. Its `gh` can only read from GitHub, through a relay; every write is made
by the Action after the run. Without password-free `sudo` the run stops and
says why, unless you set `allow-unisolated: true`.

Use the starter file rather than writing your own. It includes safeguards that
are easy to miss:

- a filter so comments not meant for Test Companion don't start a job;
- `persist-credentials: false` on checkout, so the workflow token is not left
  in `.git/config` where the agent could read it;
- concurrency rules that keep one run per pull request and let closing a pull
  request cancel its run.

**Already using an older copy?** Copy the starter file again. Older copies let
comments written by bots, Test Companion's own included, start a run, which
costs a runner each time and can push a waiting `go` out of the queue.

## Pin the CLI version

Without a pin the CLI upgrades itself on a release day, so two runs a day apart
may not run the same software. Set `cli-version` and `cli-sha256` together,
from the release you tested; a version without a checksum is refused.

```yaml
      - uses: browserstack/github-actions/test-companion@v1.1.0
        with:
          username: ${{ secrets.BROWSERSTACK_USERNAME }}
          access-key: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
          cli-version: "1.1.16"
          cli-sha256: "<sha256 of that release for linux-amd64>"
```

## Inputs

| Input | Required | What it does |
|---|---|---|
| `username` | yes | BrowserStack username, from your secret store |
| `access-key` | yes | BrowserStack access key, from your secret store |
| `cli-version` | no | Pin the CLI. Recommended, see above |
| `cli-sha256` | no | Checksum for the pinned version |
| `build-effect` | no | When this step fails. `fail-on-break` (default): the run broke, could not start or hit a limit, not test failures. `report`: never. `fail`: anything but success. The check reports the real outcome either way |
| `workflow` | no | Manual runs only; event-driven runs read the pipeline file |
| `preview` | no | Report what would happen and change nothing |
| `allow-unisolated` | no | `"true"` runs the agent as the job's own user when it cannot be locked down, where it can reach this job's tokens and secrets. Off by default |
| `app-id` / `app-private-key` | no | Post as the GitHub App. Keep the workflow's `permissions:` block: the workflow token is the fallback |
| `github-token` | no | The token for the Action's own GitHub calls. Leave it as the default (the workflow token) or use the GitHub App's token, never a personal access token: Test Companion recognises its own comments by their bot account, and a person's token would make them look like that person's |

## Approving a plan

Before a job changes anything, Test Companion posts its plan and waits for
someone with write access to reply `go`. Read the plan before you reply.
Test Companion reacts 👀 to a request, or a `go`, once it picks it up.

For `generate`, a plain `go` saves exactly the test cases in the plan to Test
Management, in the project and folder the plan shows under "Will be saved to":
the plan's run keeps them (the `test-companion-cases` artifact, for 7 days) and
nothing is generated again. This needs **Test Companion CLI 1.1.16 or later**,
for both the plan and the `go`; with an older CLI nothing is saved and the reply
says to update it. A `@browserstack go` with changes generates the cases again
with your changes as guidance, and says so. If the plan's cases can't be found
or have changed, or the plan recorded no Test Management destination (set
`tm_project` and `tm_folder` for generate in the pipeline file), nothing is
saved and you are asked to generate a fresh plan.

For `fix` and `automate`, the work is handed back as a pull request:

- opened as a draft (a normal pull request where drafts aren't available);
- based on the pull request it was asked on, so it carries only the fix (if the
  run started on the default branch instead of that pull request's commit, it's
  based on the default branch, and the reply says so; if it started on GitHub's
  merge of the pull request, nothing is opened, because it would carry the
  whole pull request);
- one squashed commit by Test Companion's bot account, so the agent's own
  commits never reach GitHub;
- tool by-products (logs, `.env`, `browserstack.err` and the like) left out;
- refused, with nothing pushed, if the agent's branch rewrote history, for
  example by resetting past the commit that was reviewed.

### The GitHub App's permissions

Installing the App asks for these repository permissions, and each run's token
is limited to the one repository it runs in:

| Permission | Why |
|---|---|
| Contents: read and write | Commits approved tests to the pull request's branch, and pushes the branch for a hand-back pull request |
| Pull requests: read and write | Posts its replies, and opens the hand-back pull request |
| Checks: read and write | Posts the "Test Companion" check |
| Actions: read and write | Read: the failed run's logs for `explain`, `fix` and `find the bad PR`, and the plan's saved cases when a `generate` plan is approved. Write: cancelling its own runs when a pull request is closed without merging |

Without the GitHub App, Test Companion posts as `github-actions[bot]`, the
account every workflow in your repository shares, and recognises its own plans
by that account and a hidden marker. Another workflow that copies outside text
into a comment could imitate a plan. A `go` only ever approves a plan for the
pull request's current commit. With the App, Test Companion posts under its own
account, which no other workflow can use.

## How the CLI is installed

Each run downloads the installer from
`test-companion.browserstack.com/cli/install.sh`. The installer itself is not
checked against a fixed checksum, so a run trusts that address. Pinning
`cli-version` with `cli-sha256` makes it refuse any CLI build but the one you
tested.

## Notes for maintainers

A composite action with no dependencies and no `dist/` bundle: the sources in
`src/` are what run.

Tests: `cd test-companion && node --test`. No network or credentials needed.
