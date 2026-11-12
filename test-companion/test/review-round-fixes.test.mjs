import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
	findProposal,
	planSpentState,
	proposalNeedsDropping,
	proposalConsumedMarkerFor,
	proposalMarkerFor,
	renderJobSummary,
} from "../src/report.mjs"
import {
	matchFailedByName,
	renderBuildNote,
	renderCiStillRunning,
	checkNamedRun,
	classifyLookup,
	prCommitShas,
	parseRunReference,
	PR_COMMIT_LIST_LIMIT,
} from "../src/runs.mjs"
import { isRequestedByPerson } from "../src/push-work.mjs"
import { readIntent } from "../src/intent.mjs"

const US = "browserstack[bot]"
const SHA = "abc1234"
const now = Date.parse("2026-11-12T12:00:00Z")
const fresh = "2026-11-12T11:00:00Z"
const stale = "2026-11-10T11:00:00Z"
const plan = (id, workflow = "fix", { created = fresh, extra = "" } = {}) => ({
	id,
	user: { type: "Bot", login: US },
	created_at: created,
	html_url: `https://x/${id}`,
	body: `the plan ${id}${extra}\n\n${proposalMarkerFor(SHA, "alice", workflow)}`,
})
const ours = (id, body) => ({ id, user: { type: "Bot", login: US }, created_at: fresh, body })

describe("approving a newer plan also spends the older ones of that job", () => {
	// Two plans for the same job on one commit; the newer one was approved.
	const comments = (created = fresh) => [
		plan(100, "fix", { created }),
		plan(200, "fix", { created }),
		ours(300, `run report\n${proposalConsumedMarkerFor(SHA, "fix", 200)}`),
	]

	test("a bare go finds no waiting plan, so the older plan can't be run", () => {
		assert.equal(findProposal(comments(), SHA, now, US), undefined)
	})

	test("the nightly sweep has nothing to drop, so it never flips the check", () => {
		assert.equal(proposalNeedsDropping(comments(stale), SHA, now, US), false)
	})

	test("go #<older plan> is told it was already approved", () => {
		assert.equal(planSpentState(comments(), 100, US), "approved")
		assert.equal(planSpentState(comments(), 200, US), "approved")
	})

	test("approving the older plan leaves the newer one approvable", () => {
		const c = [plan(100), plan(200), ours(300, proposalConsumedMarkerFor(SHA, "fix", 100))]
		assert.equal(findProposal(c, SHA, now, US)?.id, 200)
		assert.equal(planSpentState(c, 200, US), undefined)
	})

	test("an older plan for a different job stays open", () => {
		const c = [plan(100, "generate"), plan(200, "fix"), ours(300, proposalConsumedMarkerFor(SHA, "fix", 200))]
		assert.equal(findProposal(c, SHA, now, US)?.id, 100)
	})
})

describe("naming a failed workflow in the comment", () => {
	const failed = [
		{ id: 9, name: "Lint" },
		{ id: 8, name: "CI" },
		{ id: 7, name: "Build and Test" },
		{ id: 6, name: "Lint Checks" },
		{ id: 5, name: "Deploy main" },
		{ id: 4, name: "e2e" },
	]
	const pick = (text) => matchFailedByName(text, failed)?.name

	test("a whole workflow name wins, longest first", () => {
		assert.equal(pick("@browserstack explain CI"), "CI")
		assert.equal(pick("@browserstack explain Build and Test"), "Build and Test")
		assert.equal(pick("@browserstack explain Lint Checks"), "Lint Checks")
		assert.equal(pick("@browserstack explain lint"), "Lint")
		assert.equal(pick("@browserstack explain e2e please"), "e2e")
	})

	test("an incidental word does not name a workflow", () => {
		assert.equal(pick("@browserstack explain the failure on main"), undefined)
		assert.equal(pick("@browserstack explain why the build failed"), undefined)
		assert.equal(pick("@browserstack explain"), undefined)
	})

	test("every significant word of a name counts as naming it", () => {
		assert.equal(pick("@browserstack explain the main deploy"), "Deploy main")
	})
})

describe("the 'also failed' hint asks by run id", () => {
	const note = renderBuildNote(
		{ id: 9, name: "Lint", url: "https://github.com/o/r/actions/runs/9" },
		{ otherFailed: [{ id: 12345678, name: "CI", url: "u" }], ask: "explain" },
	)

	test("the hint names the run by id, which the parser and intent reader understand", () => {
		assert.match(note, /`@browserstack explain run 12345678`/)
		assert.deepEqual(parseRunReference("@browserstack explain run 12345678", { repo: "o/r" }), { id: "12345678" })
		assert.equal(readIntent("explain run 12345678", { workflows: ["rca", "fix"] }).workflow, "rca")
	})
})

describe("workflow names in replies are inert", () => {
	const hostile = { id: 1, name: "x @org/core #12 *y* https://e.example", url: "https://github.com/o/r/actions/runs/1" }

	test("names are code spans, so they can't mention, link or format", () => {
		const note = renderBuildNote(hostile, { otherFailed: [hostile], running: [hostile] })
		assert.ok(note.includes("`x @org/core #12 *y* https://e.example`"))
		assert.doesNotMatch(note, /\*\*x @org/)
		const running = renderCiStillRunning("abcdef0123", [hostile], [hostile])
		assert.ok(running.includes("`x @org/core #12 *y* https://e.example`"))
	})
})

describe("isRequestedByPerson", () => {
	test("a pull request comment is a person's request (bots are filtered earlier)", () => {
		assert.equal(isRequestedByPerson({ isPrComment: true }), true)
	})

	test("a manual run counts only when a human account started it", () => {
		assert.equal(isRequestedByPerson({ eventName: "workflow_dispatch", sender: { type: "User", login: "alice" } }), true)
		assert.equal(
			isRequestedByPerson({ eventName: "workflow_dispatch", sender: { type: "Bot", login: "browserstack[bot]" } }),
			false,
		)
		assert.equal(
			isRequestedByPerson({ eventName: "workflow_dispatch", sender: { type: "User", login: "github-actions[bot]" } }),
			false,
		)
		assert.equal(isRequestedByPerson({ eventName: "workflow_dispatch" }), false)
	})

	test("automatic events never count", () => {
		for (const eventName of ["push", "pull_request", "schedule", "workflow_run"]) {
			assert.equal(isRequestedByPerson({ eventName, sender: { type: "User", login: "alice" } }), false)
		}
	})
})

describe("run lookups fail closed and say so", () => {
	test("a 404 is not found; any other failure is a failed lookup", () => {
		assert.deepEqual(classifyLookup({ status: 0, stdout: '{"id":1}' }), { found: { id: 1 } })
		assert.deepEqual(classifyLookup({ status: 1, stderr: "gh: Not Found (HTTP 404)" }), { notFound: true })
		assert.deepEqual(classifyLookup({ status: 1, stderr: "gh: Server Error (HTTP 502)" }), { failed: true })
		assert.deepEqual(classifyLookup({ status: 0, stdout: "not json" }), { failed: true })
		assert.deepEqual(classifyLookup(undefined), { failed: true })
	})

	test("commit ids drop missing values and always include the head", () => {
		const got = prCommitShas([[{ sha: "a" }, {}, null, { sha: undefined }], [{ sha: "b" }]], "h")
		assert.deepEqual(got, { shas: ["a", "b", "h"], complete: true })
	})

	test("a failed listing keeps only the head and is marked incomplete", () => {
		assert.deepEqual(prCommitShas(null, "h"), { shas: ["h"], complete: false })
	})

	test("a listing cut off at GitHub's limit is marked incomplete", () => {
		const page = Array.from({ length: PR_COMMIT_LIST_LIMIT }, (_, i) => ({ sha: `s${i}` }))
		assert.equal(prCommitShas([page], "h").complete, false)
	})

	test("a run with no commit id never matches, even if the list held a gap", () => {
		const run = { id: 5, html_url: "u", status: "completed", conclusion: "failure" }
		assert.ok(checkNamedRun(run, { prShas: prCommitShas([[{}]], "h").shas }).why)
	})

	test("a run on an unlisted commit of a too-long pull request says why", () => {
		const run = { id: 5, html_url: "u", head_sha: "old", status: "completed", conclusion: "failure" }
		assert.match(checkNamedRun(run, { prShas: ["h"], shasComplete: false }).why, /couldn't list all/)
		assert.match(checkNamedRun(run, { prShas: ["h"], shasComplete: true }).why, /not for a commit on this pull request/)
	})
})

describe("the read-only line follows the job that was asked for", () => {
	const summary = { preview: "true" }

	test("explain shows the read-only line", () => {
		const md = renderJobSummary({ workflow: "rca", planWorkflow: "rca", outcome: "Succeeded", summary })
		assert.match(md, /Read-only: this job explains what happened; nothing it does is saved\./)
		assert.doesNotMatch(md, /\*\*Preview\*\*/)
	})

	test("an agent-written summary can't swap the preview banner for the read-only line", () => {
		const md = renderJobSummary({ workflow: "rca", outcome: "Succeeded", summary: { ...summary, workflow: "rca" } })
		assert.match(md, /\*\*Preview\*\*/)
		assert.doesNotMatch(md, /Read-only/)
	})

	test("a preview of a job that writes keeps the banner", () => {
		const md = renderJobSummary({ workflow: "fix", planWorkflow: "fix", outcome: "Succeeded", summary })
		assert.match(md, /\*\*Preview\*\*/)
	})
})
