import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { chooseRunsToCancel, runIdsFromChecks, latestFailedRun } from "../src/runs.mjs"

const inProgress = (id, over = {}) => ({
	id,
	status: "in_progress",
	head_sha: "abc123",
	name: "Test Companion",
	...over,
})

describe("chooseRunsToCancel — FR-35", () => {
	test("cancels a run in flight on the same commit", () => {
		assert.deepEqual(chooseRunsToCancel([inProgress(1)], { selfRunId: "99", headSha: "abc123" }), [1])
	})

	test("a queued run counts as in flight", () => {
		assert.deepEqual(chooseRunsToCancel([inProgress(1, { status: "queued" })], { selfRunId: "99", headSha: "abc123" }), [1])
	})

	/**
	 * The one that would hurt. The run handling the "stop" comment is itself an
	 * in-flight run on that commit, so a naive filter cancels the very job doing
	 * the cancelling — and the person is told nothing, because the process that
	 * owed them a reply is gone.
	 */
	test("never cancels itself", () => {
		assert.deepEqual(chooseRunsToCancel([inProgress(99)], { selfRunId: "99", headSha: "abc123" }), [])
	})

	test("the id is matched as a value, not a type", () => {
		// GITHUB_RUN_ID arrives as a string; the API returns a number.
		assert.deepEqual(chooseRunsToCancel([inProgress(99)], { selfRunId: 99, headSha: "abc123" }), [])
	})

	test("leaves finished runs alone", () => {
		const done = inProgress(1, { status: "completed", conclusion: "success" })
		assert.deepEqual(chooseRunsToCancel([done], { selfRunId: "99", headSha: "abc123" }), [])
	})

	test("leaves runs on another commit alone", () => {
		assert.deepEqual(chooseRunsToCancel([inProgress(1, { head_sha: "deadbee" })], { selfRunId: "99", headSha: "abc123" }), [])
	})

	/**
	 * "Stop" means stop Test Companion, not stop the repository's own build. A
	 * comment must never be a way to cancel someone else's CI.
	 */
	test("leaves other workflows alone when we know our own name", () => {
		const theirs = inProgress(1, { name: "Build and deploy" })
		assert.deepEqual(chooseRunsToCancel([theirs], { selfRunId: "99", headSha: "abc123", workflowName: "Test Companion" }), [])
	})

	test("cancels several of ours at once", () => {
		const runs = [inProgress(1), inProgress(2), inProgress(99)]
		assert.deepEqual(chooseRunsToCancel(runs, { selfRunId: "99", headSha: "abc123" }), [1, 2])
	})

	test("nothing to cancel is an empty list, not a throw", () => {
		assert.deepEqual(chooseRunsToCancel(undefined, {}), [])
		assert.deepEqual(chooseRunsToCancel([], {}), [])
	})
})

describe("runIdsFromChecks — finding OUR in-flight runs on a commit (FR-35)", () => {
	/**
	 * The defect this replaces. cancelRunsOn asked GitHub for
	 * `actions/runs?head_sha=<the pull request's head>`, but a run started by
	 * an ISSUE_COMMENT carries the DEFAULT BRANCH's sha — that is what GitHub
	 * checks out for that event. The query matched nothing, so `stop` replied
	 * "nothing is running" with a run plainly in flight, and closing a pull
	 * request did not stop its run either. Both verified live on 2026-10-29.
	 *
	 * A run's own `pull_requests` field is NOT the answer: for an
	 * issue_comment run it reports the pull request whose HEAD is the
	 * checked-out branch, which is a different pull request entirely. Observed:
	 * a run for PR #22 reporting number 18.
	 *
	 * So the handle is our own check run. It is posted on the pull request's
	 * head commit, it carries the run id in external_id, and nobody else
	 * writes it.
	 */
	const check = (id, status, name = "Test Companion") => ({ name, status, external_id: String(id) })

	test("returns the run ids of our in-flight checks", () => {
		const ids = runIdsFromChecks([check(111, "in_progress"), check(222, "queued")], { selfRunId: "999" })
		assert.deepEqual(ids.sort(), ["111", "222"])
	})

	test("never cancels the run doing the cancelling", () => {
		assert.deepEqual(runIdsFromChecks([check(111, "in_progress")], { selfRunId: "111" }), [])
		assert.deepEqual(runIdsFromChecks([check(111, "in_progress")], { selfRunId: 111 }), [])
	})

	test("a finished check is not something to stop", () => {
		assert.deepEqual(runIdsFromChecks([check(111, "completed")], { selfRunId: "999" }), [])
	})

	/** "Stop" means stop Test Companion, never the repository's own build. */
	test("somebody else's check is left alone", () => {
		assert.deepEqual(runIdsFromChecks([check(111, "in_progress", "CI / build")], { selfRunId: "999" }), [])
	})

	test("a check with no run id on it is skipped rather than guessed at", () => {
		assert.deepEqual(runIdsFromChecks([{ name: "Test Companion", status: "in_progress" }], { selfRunId: "9" }), [])
	})

	test("duplicates collapse, so one run is not cancelled twice", () => {
		const ids = runIdsFromChecks([check(111, "in_progress"), check(111, "queued")], { selfRunId: "999" })
		assert.deepEqual(ids, ["111"])
	})

	test("nothing in, nothing out", () => {
		assert.deepEqual(runIdsFromChecks([], {}), [])
		assert.deepEqual(runIdsFromChecks(undefined, {}), [])
	})
})

describe("latestFailedRun — which build 'explain the failure' means", () => {
	/**
	 * `rca`, `fix` and `verdict` need to know WHICH build failed. On a
	 * build_failed trigger GitHub hands us the run and the Action passes
	 * `run.html_url` straight through. From a pull request COMMENT nobody
	 * hands us one, so those three failed on the first comment with "Could
	 * not run" — while CAPABILITIES advertises all three by name.
	 *
	 * Nothing about that needed deciding: the same answer is a lookup. The
	 * newest failed workflow run on the pull request's head commit is the
	 * build a person means when they say "explain the failure".
	 */
	const run = (id, conclusion, name = "CI", status = "completed") => ({
		id,
		name,
		status,
		conclusion,
		html_url: `https://github.com/acme/shop/actions/runs/${id}`,
	})

	test("picks the newest failed run", () => {
		const got = latestFailedRun([run(1, "failure"), run(9, "failure"), run(5, "success")], {})
		assert.equal(got, "https://github.com/acme/shop/actions/runs/9")
	})

	test("a green pull request has nothing to explain", () => {
		assert.equal(latestFailedRun([run(1, "success"), run(2, "success")], {}), undefined)
		assert.equal(latestFailedRun([], {}), undefined)
		assert.equal(latestFailedRun(undefined, {}), undefined)
	})

	/** Explaining our OWN failure is a mirror, not an answer. */
	test("never picks a Test Companion run", () => {
		const got = latestFailedRun([run(9, "failure", "Test Companion"), run(3, "failure", "CI")], {
			selfWorkflowName: "Test Companion",
		})
		assert.equal(got, "https://github.com/acme/shop/actions/runs/3")
	})

	test("never picks the run doing the asking", () => {
		const got = latestFailedRun([run(9, "failure"), run(3, "failure")], { selfRunId: "9" })
		assert.equal(got, "https://github.com/acme/shop/actions/runs/3")
	})

	/** A run still going has not failed yet. */
	test("ignores runs that have not finished", () => {
		const got = latestFailedRun([run(9, null, "CI", "in_progress"), run(3, "failure")], {})
		assert.equal(got, "https://github.com/acme/shop/actions/runs/3")
	})

	test("cancelled and timed out count as failed — they are red to a reader", () => {
		assert.ok(latestFailedRun([run(4, "cancelled")], {}))
		assert.ok(latestFailedRun([run(4, "timed_out")], {}))
	})

	test("a run with no url is skipped rather than guessed at", () => {
		const bare = { id: 9, status: "completed", conclusion: "failure" }
		assert.equal(latestFailedRun([bare, run(3, "failure")], {}), "https://github.com/acme/shop/actions/runs/3")
	})
})
