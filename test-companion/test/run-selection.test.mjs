import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
	ciOnCommit,
	parseRunReference,
	matchFailedByName,
	checkNamedRun,
	renderCiStillRunning,
	renderBuildNote,
	runRequestFor,
} from "../src/runs.mjs"
import { findProposal, renderProposal, proposalMarkerFor } from "../src/report.mjs"

const SHA = "a".repeat(40)
const US = "browserstack[bot]"

const run = (id, name, status, conclusion = null, extra = {}) => ({
	id,
	name,
	status,
	conclusion,
	html_url: `https://github.com/o/r/actions/runs/${id}`,
	head_sha: "abc1234",
	head_repository: { full_name: "o/r" },
	...extra,
})

describe("ciOnCommit", () => {
	test("splits red and still-running runs, newest first, leaving out our own", () => {
		const ci = ciOnCommit(
			[
				run(1, "Unit tests", "completed", "failure"),
				run(3, "E2E", "completed", "failure"),
				run(2, "Lint", "completed", "success"),
				run(4, "Deploy", "in_progress"),
				run(5, "Test Companion", "in_progress"),
				run(6, "Other", "completed", "failure"),
			],
			{ selfRunId: 6, selfWorkflowName: "Test Companion", repo: "o/r" },
		)
		assert.deepEqual(
			ci.failed.map((r) => r.name),
			["E2E", "Unit tests"],
		)
		assert.deepEqual(
			ci.running.map((r) => r.name),
			["Deploy"],
		)
	})

	test("a workflow name can't break the comment's formatting", () => {
		const ci = ciOnCommit([run(1, "x`] (evil)|\nname", "completed", "failure")], { repo: "o/r" })
		assert.doesNotMatch(ci.failed[0].name, /[`[\]|\n]/)
	})
})

describe("parseRunReference", () => {
	const opts = { repo: "Org/Repo", serverUrl: "https://github.com" }

	test("a run link for this repository, with or without a job", () => {
		assert.deepEqual(parseRunReference("explain https://github.com/org/repo/actions/runs/123", opts), { id: "123" })
		assert.deepEqual(parseRunReference("fix https://github.com/Org/Repo/actions/runs/456/job/789", opts), { id: "456" })
	})

	test("a link to another repository or host is refused", () => {
		assert.ok(parseRunReference("explain https://github.com/evil/repo/actions/runs/1", opts).error)
		assert.ok(parseRunReference("explain https://example.com/org/repo/actions/runs/1", opts).error)
	})

	test("`run <id>` with a long enough number", () => {
		assert.deepEqual(parseRunReference("explain run 43189383014", opts), { id: "43189383014" })
		assert.deepEqual(parseRunReference("explain run #43189383014", opts), { id: "43189383014" })
		assert.equal(parseRunReference("explain run 12", opts), undefined)
	})

	test("nothing named, including a plan id in a go", () => {
		assert.equal(parseRunReference("explain", opts), undefined)
		assert.equal(parseRunReference("go #6824956824", opts), undefined)
		assert.equal(parseRunReference(undefined, opts), undefined)
	})

	test("a GitHub Enterprise host is matched from the server URL", () => {
		const ghe = { repo: "org/repo", serverUrl: "https://ghe.example.com" }
		assert.deepEqual(parseRunReference("https://ghe.example.com/org/repo/actions/runs/9", ghe), { id: "9" })
		assert.ok(parseRunReference("https://github.com/org/repo/actions/runs/9", ghe).error)
	})
})

describe("matchFailedByName", () => {
	const failed = [
		{ id: 3, name: "E2E Tests", url: "u3" },
		{ id: 1, name: "Unit tests", url: "u1" },
	]
	test("a word from the workflow name picks that run", () => {
		assert.equal(matchFailedByName("explain e2e", failed).id, 3)
		assert.equal(matchFailedByName("why did unit fail", failed).id, 1)
	})
	test("job words and filler never pick a run", () => {
		assert.equal(matchFailedByName("explain the failing tests please", failed), undefined)
		assert.equal(matchFailedByName("browserstack fix", failed), undefined)
		assert.equal(matchFailedByName("", failed), undefined)
	})
})

describe("checkNamedRun", () => {
	const prShas = ["abc1234", "def5678"]
	test("a finished red run on one of the PR's commits is used", () => {
		const r = checkNamedRun(run(9, "E2E", "completed", "failure"), { prShas, repo: "o/r" })
		assert.deepEqual(r, { ok: true, url: "https://github.com/o/r/actions/runs/9", name: "E2E" })
	})
	test("each reason a run can't be used", () => {
		assert.match(checkNamedRun(null, { prShas, repo: "o/r" }).why, /could not find/)
		assert.match(checkNamedRun(run(9, "E2E", "completed", "failure", { head_sha: "zzz" }), { prShas, repo: "o/r" }).why, /not for a commit/)
		assert.match(checkNamedRun(run(9, "E2E", "in_progress"), { prShas, repo: "o/r" }).why, /still going/)
		assert.match(checkNamedRun(run(9, "E2E", "completed", "success"), { prShas, repo: "o/r" }).why, /did not fail/)
		assert.match(checkNamedRun(run(9, "TC", "completed", "failure"), { prShas, selfWorkflowName: "TC", repo: "o/r" }).why, /own runs/)
	})
})

describe("the replies", () => {
	test("CI still running lists what is going", () => {
		const text = renderCiStillRunning("abcdef1234", [{ name: "Unit tests" }, { name: "E2E" }])
		assert.match(text, /CI is still running on `abcdef1`: `Unit tests`, `E2E`/)
		assert.match(text, /Ask me again when it finishes/)
	})
	test("CI still running caps the list at five", () => {
		const many = Array.from({ length: 7 }, (_, i) => ({ name: `w${i}` }))
		assert.match(renderCiStillRunning("abc", many), /and 2 more/)
	})
	test("the build note says which run was used and what else failed", () => {
		const note = renderBuildNote(
			{ name: "E2E", url: "https://x/1" },
			{ otherFailed: [{ id: 4242424, name: "Unit tests" }], running: [{ name: "Deploy" }], ask: "explain" },
		)
		assert.match(note, /Looked at `E2E` \(\[run\]\(https:\/\/x\/1\)\)/)
		assert.match(note, /Also failed: `Unit tests`\. To look at one, ask `@browserstack explain run 4242424`/)
		assert.match(note, /Still running: `Deploy`/)
	})
	test("no other failures, no extra text", () => {
		assert.equal(renderBuildNote({ name: "E2E", url: "u" }), "Looked at `E2E` ([run](u)).")
		assert.equal(renderBuildNote(undefined), "")
	})
})

describe("approving a plan reads the run that plan looked at", () => {
	const opts = { repo: "org/repo", serverUrl: "https://github.com" }
	// Newest first, as ciOnCommit returns them: Lint failed after E2E.
	const lint = { id: 300, name: "Lint", url: "https://github.com/org/repo/actions/runs/300" }
	const e2e = { id: 200, name: "E2E Tests (linux)", url: "https://github.com/org/repo/actions/runs/200" }
	const failed = [lint, e2e]
	const plannedFrom = (requestText) => {
		const asked = runRequestFor({ approving: false, requestText, ...opts })
		return asked.named?.id ?? (matchFailedByName(requestText, failed) ?? failed[0]).id
	}
	const approvedRun = (body) => {
		const waiting = findProposal([{ id: 9, user: { login: US, type: "Bot" }, created_at: new Date().toISOString(), body }], SHA, Date.now(), US)
		return runRequestFor({ approving: true, plannedRunId: waiting?.buildRunId, requestText: "go", ...opts })
	}

	test("`fix e2e` then `go` fixes E2E, though Lint is newer and also red", () => {
		const build = plannedFrom("@browserstack fix e2e")
		assert.equal(String(build), "200")
		const asked = approvedRun(renderProposal("plan", SHA, "octocat", "fix", "111", { build }))
		assert.deepEqual(asked, { named: { id: "200" } })
	})

	test("`fix run <id>` then `go` fixes that run", () => {
		const build = plannedFrom("@browserstack fix run 200000")
		assert.equal(build, "200000")
		assert.deepEqual(approvedRun(renderProposal("plan", SHA, "octocat", "fix", "111", { build })), { named: { id: "200000" } })
	})

	test("`go` itself never names a run, so it can't choose one", () => {
		assert.deepEqual(runRequestFor({ approving: false, requestText: "go", ...opts }), { named: undefined })
	})

	test("a plan that didn't record its run is refused, never re-chosen", () => {
		assert.deepEqual(approvedRun(renderProposal("plan", SHA, "octocat", "fix", "111")), { refuse: "no-planned-run" })
	})

	test("the recorded run is still checked: one that is no longer red can't be used", () => {
		const run = { id: 200, html_url: e2e.url, head_sha: SHA, status: "completed", conclusion: "success", name: e2e.name, head_repository: { full_name: "org/repo" } }
		assert.match(checkNamedRun(run, { prShas: [SHA], repo: "org/repo" }).why, /did not fail/)
	})

	test("the marker keeps the run and still reads markers without it", () => {
		assert.match(proposalMarkerFor(SHA, "o", "fix", "111", { build: "200" }), / run=111 build=200 -->$/)
		assert.equal(proposalMarkerFor(SHA, "o", "fix", "111", { build: "2 00" }).includes("build="), false)
		const old = findProposal([{ id: 9, user: { login: US, type: "Bot" }, created_at: new Date().toISOString(), body: `p\n\n<!-- test-companion-proposal sha=${SHA} by=o workflow=fix run=111 -->` }], SHA, Date.now(), US)
		assert.equal(old.runId, "111")
		assert.equal(old.buildRunId, undefined)
	})
})

describe("a fork's run is never the one read", () => {
	const fork = (id, extra = {}) => run(id, "CI", "completed", "failure", { head_repository: { full_name: "mallory/r" }, ...extra })

	test("a fork's red run on the same commit is left out", () => {
		const ci = ciOnCommit([fork(9), run(3, "E2E", "completed", "failure")], { repo: "o/r" })
		assert.deepEqual(
			ci.failed.map((r) => r.id),
			[3],
		)
	})

	test("the repository is compared without case", () => {
		assert.equal(ciOnCommit([run(3, "E2E", "completed", "failure")], { repo: "O/R" }).failed.length, 1)
	})

	test("a run that doesn't say where it came from is left out", () => {
		const unknown = run(3, "E2E", "completed", "failure", { head_repository: undefined })
		assert.equal(ciOnCommit([unknown], { repo: "o/r" }).failed.length, 0)
		assert.match(checkNamedRun(unknown, { prShas: ["abc1234"], repo: "o/r" }).why, /fork/)
	})

	test("a caller that doesn't say which repository gets nothing", () => {
		assert.equal(ciOnCommit([run(3, "E2E", "completed", "failure")], {}).failed.length, 0)
		assert.match(checkNamedRun(run(3, "E2E", "completed", "failure"), { prShas: ["abc1234"] }).why, /fork/)
	})

	test("naming a fork's run is refused", () => {
		assert.match(checkNamedRun(fork(9), { prShas: ["abc1234"], repo: "o/r" }).why, /started from a fork/)
	})
})
