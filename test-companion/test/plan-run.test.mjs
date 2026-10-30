import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { planRun, TC_EVENTS, contextArgs, withPullRequestHead } from "../src/plan-run.mjs"

// Minimal payload builders. Each returns the shape GitHub actually puts in
// $GITHUB_EVENT_PATH for that event, trimmed to the fields we read.
const pr = (over = {}) => ({
	number: 412,
	draft: false,
	merged: false,
	state: "open",
	title: "Fix the checkout total",
	head: { sha: "abc123", ref: "fix/checkout", repo: { full_name: "acme/shop" } },
	base: { ref: "main", repo: { full_name: "acme/shop" } },
	...over,
})

const plan = (eventName, payload, over = {}) => planRun({ eventName, payload, inputs: {}, repo: "acme/shop", ...over })

describe("comment trigger", () => {
	test("a @test-companion comment on a pull request starts a run", () => {
		const r = plan("issue_comment", {
			action: "created",
			issue: { number: 412, pull_request: { url: "x" } },
			comment: { body: "@test-companion test this PR against SHOP-221", user: { login: "dev" } },
		})
		assert.equal(r.skip, undefined)
		assert.equal(r.event, TC_EVENTS.PR_COMMENT)
		assert.equal(r.context.pr, "412")
	})

	// The comment's wording is the user's instruction — it is the whole point of
	// the trigger, so it has to reach the run rather than being thrown away.
	test("carries what the person actually asked for", () => {
		const r = plan("issue_comment", {
			action: "created",
			issue: { number: 412, pull_request: { url: "x" } },
			comment: { body: "@test-companion test this PR against SHOP-221", user: { login: "dev" } },
		})
		assert.match(r.context.instructions, /SHOP-221/)
		assert.doesNotMatch(r.context.instructions, /@test-companion/, "the mention itself is not an instruction")
	})

	test("ignores a comment on an issue that is not a pull request", () => {
		const r = plan("issue_comment", {
			action: "created",
			issue: { number: 9 },
			comment: { body: "@test-companion test this", user: { login: "dev" } },
		})
		assert.equal(r.skip.reason, "not-a-pull-request")
	})

	test("ignores a comment that does not mention us", () => {
		const r = plan("issue_comment", {
			action: "created",
			issue: { number: 412, pull_request: { url: "x" } },
			comment: { body: "looks good to me", user: { login: "dev" } },
		})
		assert.equal(r.skip.reason, "not-addressed-to-us")
	})

	// FR-33: editing a comment must not start a run. Otherwise fixing a typo in
	// a months-old comment re-runs the job.
	test("ignores an edited comment", () => {
		const r = plan("issue_comment", {
			action: "edited",
			issue: { number: 412, pull_request: { url: "x" } },
			comment: { body: "@test-companion test this", user: { login: "dev" } },
		})
		assert.equal(r.skip.reason, "comment-edited")
	})
})

describe("pull request triggers", () => {
	test("opened", () => {
		const r = plan("pull_request", { action: "opened", pull_request: pr() })
		assert.equal(r.event, TC_EVENTS.PR_OPENED)
		assert.equal(r.context.sha, "abc123")
		assert.equal(r.context.branch, "fix/checkout")
	})

	test("new commits", () => {
		const r = plan("pull_request", { action: "synchronize", pull_request: pr() })
		assert.equal(r.event, TC_EVENTS.PR_UPDATED)
	})

	test("merged", () => {
		const r = plan("pull_request", {
			action: "closed",
			pull_request: pr({ merged: true, state: "closed", merge_commit_sha: "deadbee" }),
		})
		assert.equal(r.event, TC_EVENTS.PR_MERGED)
		// The merge commit is the change that landed on the base branch; the head
		// sha is the branch that no longer exists. Scoping to the wrong one makes
		// the run look at code that was never merged.
		assert.equal(r.context.sha, "deadbee")
		assert.equal(r.context.branch, "main")
	})

	test("closed without merging does nothing", () => {
		const r = plan("pull_request", { action: "closed", pull_request: pr({ merged: false }) })
		assert.equal(r.skip.reason, "closed-unmerged")
	})

	// FR-36: a draft never starts a run on its own. A comment still can, which is
	// why this check belongs here and not in the comment path.
	test("a draft pull request does not start a run on its own", () => {
		const r = plan("pull_request", { action: "opened", pull_request: pr({ draft: true }) })
		assert.equal(r.skip.reason, "draft")
	})

	// FR-3. A fork PR runs with a read-only token and no secrets, so starting
	// would fail confusingly partway. Refusing up front is the clean skip.
	test("a pull request from a fork does not run", () => {
		const r = plan("pull_request", {
			action: "opened",
			pull_request: pr({ head: { sha: "abc", ref: "x", repo: { full_name: "someone-else/shop" } } }),
		})
		assert.equal(r.skip.reason, "fork")
	})
})

describe("red build trigger", () => {
	test("a workflow that finished red", () => {
		const r = plan("workflow_run", {
			action: "completed",
			workflow_run: {
				name: "CI",
				conclusion: "failure",
				head_sha: "abc123",
				head_branch: "main",
				html_url: "https://github.com/acme/shop/actions/runs/99",
				head_repository: { full_name: "acme/shop" },
				pull_requests: [],
			},
		})
		assert.equal(r.event, TC_EVENTS.BUILD_FAILED)
		assert.equal(r.context.build, "https://github.com/acme/shop/actions/runs/99")
		assert.equal(r.context.build_status, "failed")
	})

	test("a workflow that passed does nothing", () => {
		const r = plan("workflow_run", {
			action: "completed",
			workflow_run: {
				name: "CI",
				conclusion: "success",
				head_sha: "a",
				head_branch: "main",
				head_repository: { full_name: "acme/shop" },
			},
		})
		assert.equal(r.skip.reason, "build-not-red")
	})

	// FR-21: never explain a red run that is our own. Without this, a failing
	// Test Companion check triggers a run to explain the failing Test Companion
	// check, which triggers another one.
	test("never explains its own failed run", () => {
		const r = plan(
			"workflow_run",
			{
				action: "completed",
				workflow_run: {
					name: "Test Companion",
					conclusion: "failure",
					head_sha: "a",
					head_branch: "main",
					html_url: "u",
					head_repository: { full_name: "acme/shop" },
				},
			},
			{ inputs: { "self-workflow-name": "Test Companion" } },
		)
		assert.equal(r.skip.reason, "own-run")
	})
})

describe("other triggers", () => {
	test("a push", () => {
		const r = plan("push", { ref: "refs/heads/main", after: "abc123" })
		assert.equal(r.event, TC_EVENTS.PUSH)
		assert.equal(r.context.branch, "main")
		assert.equal(r.context.sha, "abc123")
	})

	test("a schedule", () => {
		const r = plan("schedule", {}, { ref: "refs/heads/main", sha: "abc123" })
		assert.equal(r.event, TC_EVENTS.SCHEDULE)
	})

	// FR-12: a manual run names its own job and ignores the bindings entirely,
	// which the CLI expresses as "no --event at all".
	test("a manual run carries no event, so bindings are bypassed", () => {
		const r = plan(
			"workflow_dispatch",
			{},
			{ inputs: { workflow: "rca", preview: "true" }, sha: "abc", ref: "refs/heads/main" },
		)
		assert.equal(r.event, undefined, "a manual run must not send --event")
		assert.equal(r.workflow, "rca")
		assert.equal(r.preview, true)
	})

	test("an unsupported event is skipped rather than guessed at", () => {
		const r = plan("label", {})
		assert.equal(r.skip.reason, "unsupported-event")
	})
})

describe("safety", () => {
	// The CLI rejects a flag-like context value (CWE-88). A pull request title or
	// comment is attacker-controlled on a public repo, so catch it before it is
	// ever put on a command line.
	test("refuses a context value that looks like a flag", () => {
		const r = plan("issue_comment", {
			action: "created",
			issue: { number: 412, pull_request: { url: "x" } },
			comment: { body: "@test-companion --yolo --max-cost 9999", user: { login: "dev" } },
		})
		assert.equal(r.skip.reason, "unsafe-context")
	})

	test("never invents context the event did not provide", () => {
		const r = plan("push", { ref: "refs/heads/main", after: "abc123" })
		for (const [k, v] of Object.entries(r.context)) {
			assert.notEqual(v, undefined, `${k} must not be undefined`)
			assert.notEqual(v, "", `${k} must not be empty`)
		}
	})
})

describe("workflow_run is a privileged trigger", () => {
	// workflow_run runs in the BASE repo's context with full secrets, even when
	// the run it reacts to came from a fork. That is the documented GitHub
	// footgun: the fork check in the pull_request path does not cover this one.
	test("a red run from a fork does not start a privileged run", () => {
		const r = plan("workflow_run", {
			action: "completed",
			workflow_run: {
				name: "CI",
				conclusion: "failure",
				head_sha: "a",
				head_branch: "x",
				html_url: "u",
				head_repository: { full_name: "someone-else/shop" },
			},
		})
		assert.equal(r.skip.reason, "fork")
	})

	test("a red run from this repo is fine", () => {
		const r = plan("workflow_run", {
			action: "completed",
			workflow_run: {
				name: "CI",
				conclusion: "failure",
				head_sha: "a",
				head_branch: "main",
				html_url: "u",
				head_repository: { full_name: "acme/shop" },
			},
		})
		assert.equal(r.skip, undefined)
	})
})

describe("context values cannot inject extra keys", () => {
	// --context is a comma-separated k=v list, so a comment body containing a
	// comma and an equals sign could otherwise append keys of its own, e.g.
	// overriding the commit the run looks at.
	test("strips separators out of free text", () => {
		const r = plan("issue_comment", {
			action: "created",
			issue: { number: 412, pull_request: { url: "x" } },
			comment: { body: "@test-companion test it,sha=deadbeef,branch=attacker", user: { login: "d" } },
		})
		assert.equal(r.skip, undefined)
		assert.doesNotMatch(r.context.instructions, /[,=]/, "separators must not survive into a context value")
		assert.equal(r.context.sha, undefined, "a value must not be able to introduce a new key")
	})

	test("only keys the CLI actually reads are passed through", () => {
		const r = plan("pull_request", { action: "opened", pull_request: pr() })
		const allowed = new Set([
			"sha",
			"branch",
			"paths",
			"build_status",
			"pr",
			"subject",
			"url",
			"build",
			"description",
			"target",
			"cases",
			"app",
			"task",
			"instructions",
			"actor",
		])
		for (const k of Object.keys(r.context)) {
			assert.ok(allowed.has(k), `unexpected context key: ${k}`)
		}
	})
})

describe("workflow_run fails closed", () => {
	test("a payload that does not say where the run came from is refused", () => {
		const r = plan("workflow_run", {
			action: "completed",
			workflow_run: { name: "CI", conclusion: "failure", head_sha: "a", head_branch: "main", html_url: "u" },
		})
		assert.equal(r.skip.reason, "fork", "cannot-confirm must mean no on a trigger that carries secrets")
	})
})

describe("an explicitly named job", () => {
	// Naming a job should win on ANY trigger, not just a manual one. Explicit
	// beats implicit, and it gives a workflow file a way to pin one job without
	// touching the pipeline file. Found while testing: the input was silently
	// ignored on a pull_request event, which is a confusing no-op.
	test("overrides the binding on an event-driven run", () => {
		const r = plan("pull_request", { action: "opened", pull_request: pr() }, { inputs: { workflow: "generate" } })
		assert.equal(r.workflow, "generate")
		assert.equal(r.event, undefined, "naming a job means the bindings are bypassed, as for a manual run")
		assert.equal(r.context.sha, "abc123", "the event's context still applies")
	})

	test("without one, the pipeline file still decides", () => {
		const r = plan("pull_request", { action: "opened", pull_request: pr() })
		assert.equal(r.workflow, undefined)
		assert.equal(r.event, "pr_opened")
	})
})

// ── CodeRabbit findings on PR #3030 ─────────────────────────────────────────

describe("contextArgs — one flag per pair", () => {
	// A single `--context a=1,b=2` is parsed by pflag with encoding/csv, which
	// returns ErrBareQuote when an unquoted field contains a double quote. So a
	// PR titled `Fix "Pay now" button` made flag parsing fail and the whole run
	// reported "Could not run". One flag per pair takes pflag's single-pair
	// path, which never reaches the CSV reader.
	test("emits a separate --context flag for every pair", () => {
		assert.deepEqual(contextArgs({ sha: "abc", pr: "412" }), ["--context", "sha=abc", "--context", "pr=412"])
	})

	test("a double quote in a value no longer poisons the other pairs", () => {
		const args = contextArgs({ subject: 'Fix "Pay now" button', pr: "412" })
		assert.ok(args.includes("--context"))
		assert.ok(args.some((a) => a.startsWith("subject=")))
		assert.ok(args.includes("pr=412"))
	})

	test("no context means no flag at all", () => {
		assert.deepEqual(contextArgs({}), [])
	})
})

describe("cleanContext strips quotes as well as separators", () => {
	test("a quoted PR title survives as plain text", () => {
		const plan = planRun({
			eventName: "pull_request",
			payload: { action: "opened", pull_request: pr({ title: 'Fix "Pay now" button' }) },
			repo: "acme/shop",
		})
		const values = Object.values(plan.context ?? {}).join(" ")
		assert.ok(!values.includes('"'), `a double quote reached the context: ${values}`)
	})
})

describe("a pull request does not send its title as the subject", () => {
	// generateSubject in the CLI builds the commit-scoped prompt ("the change in
	// PR #N, commit SHA … covering only what that change touches") ONLY when no
	// subject is given. Sending the title meant `generate` on a pull request
	// wrote cases for the title instead of the diff, which is FR-15.
	test("pr_opened carries sha, branch and pr but no subject", () => {
		const plan = planRun({
			eventName: "pull_request",
			payload: { action: "opened", pull_request: pr() },
			repo: "acme/shop",
		})
		assert.equal(plan.context.subject, undefined)
		assert.equal(plan.context.pr, "412")
		assert.ok(plan.context.sha)
	})
})

// P1 from review: a comment-triggered run worked on the WRONG TREE.
//
// The issue_comment plan carries `pr` but no `sha`, so checkSha fell back to
// GITHUB_SHA — the default branch tip for that event — and the starter's
// checkout took the default branch too. `@test-companion generate` on PR #42
// therefore read main, and the check landed on main's latest commit.
describe("withPullRequestHead — a comment run must name the PR's own commit", () => {
	const plan = () => ({ event: "pr_comment", context: { pr: "42", instructions: "generate" } })
	const head = (over = {}) => ({
		head: { sha: "deadbeef", ref: "feat/checkout", repo: { full_name: "acme/shop" } },
		...over,
	})

	test("fills in the head sha and branch", () => {
		const out = withPullRequestHead(plan(), head(), "acme/shop")
		assert.equal(out.context.sha, "deadbeef")
		assert.equal(out.context.branch, "feat/checkout")
		assert.equal(out.context.pr, "42")
	})

	test("refuses a fork rather than running its code with our credentials", () => {
		const out = withPullRequestHead(
			plan(),
			head({ head: { sha: "x", ref: "y", repo: { full_name: "evil/shop" } } }),
			"acme/shop",
		)
		assert.equal(out.skip, "fork")
	})

	test("fails closed when the head repository is missing", () => {
		const out = withPullRequestHead(plan(), head({ head: { sha: "x", ref: "y" } }), "acme/shop")
		assert.equal(out.skip, "fork")
	})

	test("fails closed when the lookup returned nothing", () => {
		assert.equal(withPullRequestHead(plan(), null, "acme/shop").skip, "no-pr-head")
	})

	test("leaves a plan that already names a commit alone", () => {
		const p = { event: "pr_updated", context: { sha: "abc", branch: "b", pr: "1" } }
		assert.deepEqual(withPullRequestHead(p, head(), "acme/shop"), p)
	})
})

describe("a bare approval reaches us — FR-43", () => {
	/**
	 * Found by the first approved run. The proposal comment says "Reply **go**
	 * to run this for real", a person replies exactly that, and the run skipped
	 * with "No @test-companion mention, so nothing was asked of Test Companion".
	 *
	 * The proposal was instructing an action that could not work. FR-43 says "a
	 * reply of 'go'", and the PRD's own user story has the SDET replying "go"
	 * with no mention at all.
	 *
	 * Narrow on purpose: the comment must OPEN with the approval word. An
	 * unmentioned comment is still nothing to do with us in every other case,
	 * and main.mjs drops this one too unless a proposal is actually waiting.
	 */
	const comment = (body) => ({
		action: "created",
		issue: { number: 7, pull_request: {} },
		comment: { body, user: { login: "an-sdet" } },
	})

	test("a bare go is carried through, not skipped", () => {
		const out = planRun({ eventName: "issue_comment", payload: comment("go"), repo: "acme/shop" })
		assert.equal(out.skip, undefined)
		assert.equal(out.approvalOnly, true)
	})

	/**
	 * CHANGED by M3 (review of #3101). This used to be carried through, so
	 * FR-43's "edit the list while approving" worked with no mention. But
	 * "Approved, but rename the login case" is an ordinary review comment on
	 * any pull request, and unaddressed it started a live write run with the
	 * trailing text as approver edits that win.
	 *
	 * Editing while approving still works — it just has to be addressed to us
	 * now, and the proposal comment says so.
	 */
	test("go WITH EDITS needs the mention, or an ordinary review comment starts a run", () => {
		const out = planRun({ eventName: "issue_comment", payload: comment("go, but drop case two"), repo: "acme/shop" })
		assert.equal(out.skip?.reason ?? out.skip, "not-addressed-to-us")

		const addressed = planRun({
			eventName: "issue_comment",
			payload: comment("@test-companion go, but drop case two"),
			repo: "acme/shop",
		})
		assert.equal(addressed.skip, undefined)
		assert.match(addressed.context.instructions, /drop case two/)
	})

	test('"approved" works as well', () => {
		assert.equal(planRun({ eventName: "issue_comment", payload: comment("approved"), repo: "acme/shop" }).skip, undefined)
	})

	// The discriminator. "go" has to OPEN the comment, or ordinary chatter on a
	// pull request starts runs.
	test("ordinary chatter that merely contains the word is still ignored", () => {
		for (const body of ["let's go to lunch", "I'll go over this tomorrow", "this is good to go once CI passes"]) {
			const out = planRun({ eventName: "issue_comment", payload: comment(body), repo: "acme/shop" })
			assert.equal(out.skip?.reason, "not-addressed-to-us", `"${body}" must not start a run`)
		}
	})

	test("an addressed comment is unchanged and is not an approval-only one", () => {
		const out = planRun({ eventName: "issue_comment", payload: comment("@test-companion test this PR"), repo: "acme/shop" })
		assert.equal(out.skip, undefined)
		assert.ok(!out.approvalOnly)
	})

	test("an unaddressed comment that is not an approval is still ignored", () => {
		const out = planRun({ eventName: "issue_comment", payload: comment("nice work"), repo: "acme/shop" })
		assert.equal(out.skip?.reason, "not-addressed-to-us")
	})
})

describe("pull_request_target is a privileged trigger — it must fail CLOSED", () => {
	/**
	 * `pull_request_target` runs in the BASE repository's context with full
	 * secrets, even when the pull request comes from a fork. That is the
	 * documented way these workflows get compromised, and this fork check is the
	 * only thing in front of it: unlike `pull_request`, the credentials ARE
	 * present, so main.mjs's no-credentials skip never fires.
	 *
	 * GitHub sets `head.repo` to null when the fork has been DELETED. The old
	 * check required head.repo.full_name to be truthy before it would refuse, so
	 * a deleted fork sailed through — open a pull request from a fork, delete
	 * the fork, and the run executes attacker-authored code with the base
	 * repository's credentials and --yolo.
	 */
	const targetEvent = (head) => ({
		action: "opened",
		pull_request: { number: 7, draft: false, head },
	})

	test("a deleted fork (head.repo null) is refused, not run", () => {
		const out = planRun({
			eventName: "pull_request_target",
			payload: targetEvent({ sha: "abc", ref: "feature", repo: null }),
			repo: "acme/shop",
		})
		assert.equal(out.skip?.reason, "fork")
	})

	test("a payload with no head repository at all is refused", () => {
		const out = planRun({
			eventName: "pull_request_target",
			payload: targetEvent({ sha: "abc", ref: "feature" }),
			repo: "acme/shop",
		})
		assert.equal(out.skip?.reason, "fork")
	})

	test("the same hole on plain pull_request is closed too", () => {
		const out = planRun({
			eventName: "pull_request",
			payload: targetEvent({ sha: "abc", ref: "feature", repo: null }),
			repo: "acme/shop",
		})
		assert.equal(out.skip?.reason, "fork")
	})

	// Not knowing which repository we are cannot mean "assume it is ours".
	test("an unknown repository is refused rather than assumed", () => {
		const out = planRun({
			eventName: "pull_request_target",
			payload: targetEvent({ sha: "abc", ref: "feature", repo: { full_name: "acme/shop" } }),
			repo: "",
		})
		assert.equal(out.skip?.reason, "fork")
	})

	test("our own branch still runs", () => {
		const out = planRun({
			eventName: "pull_request_target",
			payload: targetEvent({ sha: "abc", ref: "feature", repo: { full_name: "acme/shop" } }),
			repo: "acme/shop",
		})
		assert.equal(out.skip, undefined)
		assert.equal(out.context.sha, "abc")
	})

	// GitHub treats repository names case-insensitively; workflow_run already
	// compares this way and pull_request did not.
	test("a case difference is the same repository, not a fork", () => {
		const out = planRun({
			eventName: "pull_request_target",
			payload: targetEvent({ sha: "abc", ref: "feature", repo: { full_name: "Acme/Shop" } }),
			repo: "acme/shop",
		})
		assert.equal(out.skip, undefined)
	})
})

describe("the flag guard sees the FINAL value, not the raw one", () => {
	/**
	 * Reported in review of PR #3101 and reproduced. `looksLikeAFlag` ran
	 * BEFORE `cleanContext`, which calls `stripSeparators` and turns `,`, `=`
	 * and `"` into spaces before trimming. So a value crafted to look safe
	 * beforehand became flag-like afterwards and the gate never saw it:
	 *
	 *   `",--config /tmp/evil.yml"`  →  guard passes  →  `--config /tmp/evil.yml`
	 *
	 * while the same text unwrapped was correctly refused. Not injectable
	 * today only because every Go arg builder re-checks — the user-visible
	 * effect was a cryptic "Could not run" instead of the clean
	 * `unsafe-context` skip this has a message for.
	 */
	const comment = (body) => ({
		action: "created",
		issue: { number: 7, pull_request: {} },
		comment: { body, user: { login: "dev" } },
	})
	const run = (body) => planRun({ eventName: "issue_comment", repo: "acme/shop", payload: comment(body) })

	test("a bare flag is refused — the case that already worked", () => {
		assert.equal(run("@test-companion --config /tmp/evil.yml").skip?.reason, "unsafe-context")
	})

	test("a flag smuggled past the guard by a separator is refused too", () => {
		const out = run('@test-companion ",--config /tmp/evil.yml"')
		assert.equal(out.skip?.reason, "unsafe-context", `leaked: ${JSON.stringify(out.context?.instructions)}`)
	})

	test("an ordinary request still gets through untouched", () => {
		const out = run("@test-companion test this PR")
		assert.equal(out.skip, undefined)
		assert.equal(out.context.instructions, "test this PR")
	})
})

/**
 * Review of PR #3101, M3.
 *
 * An UNADDRESSED comment reaches us only as a possible approval. It used to
 * be enough to open with the word, so "Approved, but rename X" — an ordinary
 * review comment on any pull request — started a live write run, with
 * "but rename X" carried in as approver edits that win.
 *
 * Unaddressed, the comment must now BE the approval and nothing else.
 * Addressed, "@test-companion go and also cover X" still works: that is
 * FR-43's "you can edit the list first", and they did address us.
 */
describe("an unaddressed comment counts as approval only when it is exactly that", () => {
	const comment = (body) =>
		plan("issue_comment", {
			action: "created",
			issue: { number: 7, pull_request: { url: "x" } },
			comment: { body, user: { login: "dev" } },
		})

	test("a bare go approves", () => {
		for (const body of ["go", "go.", "  go  ", "Go!"]) {
			assert.equal(comment(body).skip, undefined, `${JSON.stringify(body)} should be an approval`)
		}
	})

	test("an ordinary review comment that merely starts with the word does NOT", () => {
		for (const body of ["Approved, but rename the login case", "go ahead and ship it", "approved pending CI"]) {
			assert.equal(comment(body).skip?.reason ?? comment(body).skip, "not-addressed-to-us", `${JSON.stringify(body)} must not start a run`)
		}
	})

	test("addressed, edits alongside the approval are still allowed", () => {
		const plan = comment("@test-companion go, and also cover the empty-cart case")
		assert.equal(plan.skip, undefined)
		assert.match(plan.context.instructions, /also cover the empty-cart case/)
	})
})
