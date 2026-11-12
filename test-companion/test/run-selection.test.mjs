import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
	ciOnCommit,
	parseRunReference,
	matchFailedByName,
	checkNamedRun,
	renderCiStillRunning,
	renderBuildNote,
} from "../src/runs.mjs"

const run = (id, name, status, conclusion = null, extra = {}) => ({
	id,
	name,
	status,
	conclusion,
	html_url: `https://github.com/o/r/actions/runs/${id}`,
	head_sha: "abc1234",
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
			{ selfRunId: 6, selfWorkflowName: "Test Companion" },
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
		const ci = ciOnCommit([run(1, "x`] (evil)|\nname", "completed", "failure")])
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
		const r = checkNamedRun(run(9, "E2E", "completed", "failure"), { prShas })
		assert.deepEqual(r, { ok: true, url: "https://github.com/o/r/actions/runs/9", name: "E2E" })
	})
	test("each reason a run can't be used", () => {
		assert.match(checkNamedRun(null, { prShas }).why, /could not find/)
		assert.match(checkNamedRun(run(9, "E2E", "completed", "failure", { head_sha: "zzz" }), { prShas }).why, /not for a commit/)
		assert.match(checkNamedRun(run(9, "E2E", "in_progress"), { prShas }).why, /still going/)
		assert.match(checkNamedRun(run(9, "E2E", "completed", "success"), { prShas }).why, /did not fail/)
		assert.match(checkNamedRun(run(9, "TC", "completed", "failure"), { prShas, selfWorkflowName: "TC" }).why, /own runs/)
	})
})

describe("the replies", () => {
	test("CI still running lists what is going", () => {
		const text = renderCiStillRunning("abcdef1234", [{ name: "Unit tests" }, { name: "E2E" }])
		assert.match(text, /CI is still running on `abcdef1`: \*\*Unit tests\*\*, \*\*E2E\*\*/)
		assert.match(text, /Ask me again when it finishes/)
	})
	test("CI still running caps the list at five", () => {
		const many = Array.from({ length: 7 }, (_, i) => ({ name: `w${i}` }))
		assert.match(renderCiStillRunning("abc", many), /and 2 more/)
	})
	test("the build note says which run was used and what else failed", () => {
		const note = renderBuildNote(
			{ name: "E2E", url: "https://x/1" },
			{ otherFailed: [{ name: "Unit tests" }], running: [{ name: "Deploy" }], ask: "explain" },
		)
		assert.match(note, /Looked at \*\*E2E\*\* \(\[run\]\(https:\/\/x\/1\)\)/)
		assert.match(note, /Also failed: \*\*Unit tests\*\*\. To look at one, ask `@browserstack explain Unit tests`/)
		assert.match(note, /Still running: \*\*Deploy\*\*/)
	})
	test("no other failures, no extra text", () => {
		assert.equal(renderBuildNote({ name: "E2E", url: "u" }), "Looked at **E2E** ([run](u)).")
		assert.equal(renderBuildNote(undefined), "")
	})
})
