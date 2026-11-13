import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { OUTCOMES, parseSummary, resolveOutcome, checkConclusion, stepShouldFail, approvalWasSpent, runDidNotWork } from "../src/outcome.mjs"

describe("parseSummary", () => {
	test("reads the CLI's key: value report", () => {
		const s = parseSummary(["workflow: generate", "event: pr_merged", "preview: true", "outcome: succeeded"].join("\n"))
		assert.equal(s.workflow, "generate")
		assert.equal(s.preview, "true")
		assert.equal(s.outcome, "succeeded")
	})

	// Several keys are conditional, so the Action must not assume any are there.
	test("tolerates a report with keys missing", () => {
		const s = parseSummary("workflow: fix\noutcome: broke\n")
		assert.equal(s.event, undefined)
		assert.equal(s.outcome, "broke")
	})

	// A value can contain a colon (a build URL always does).
	test("keeps a value that contains a colon", () => {
		const s = parseSummary("context: build=https://ci.example.com/42")
		assert.equal(s.context, "build=https://ci.example.com/42")
	})

	test("an absent report is not a crash", () => {
		assert.deepEqual(parseSummary(undefined), {})
		assert.deepEqual(parseSummary(""), {})
	})
})

describe("resolveOutcome", () => {
	test("success", () => {
		assert.equal(resolveOutcome(0, {}), OUTCOMES.SUCCEEDED)
	})

	test("the work ran but the tests do not pass", () => {
		assert.equal(resolveOutcome(5, {}), OUTCOMES.TESTS_FAILED)
	})

	test("a ceiling is told apart from a crash, using the report", () => {
		assert.equal(resolveOutcome(4, { error_type: "ceiling_exceeded" }), OUTCOMES.STOPPED_AT_LIMIT)
		assert.equal(resolveOutcome(4, {}), OUTCOMES.RUN_BROKE)
	})

	test("not signed in is not a broken run", () => {
		assert.equal(resolveOutcome(3, {}), OUTCOMES.COULD_NOT_RUN)
	})

	test("a bad pipeline file means nothing ran", () => {
		assert.equal(resolveOutcome(2, {}), OUTCOMES.COULD_NOT_RUN)
	})

	test("blocked by plan or entitlement", () => {
		assert.equal(resolveOutcome(7, {}), OUTCOMES.COULD_NOT_RUN)
	})

	test("believes the report when it contradicts a success exit code", () => {
		assert.equal(resolveOutcome(0, { outcome: "broke" }), OUTCOMES.RUN_BROKE)
	})

	test("an unknown exit code is a broken run, never a success", () => {
		assert.equal(resolveOutcome(99, {}), OUTCOMES.RUN_BROKE)
	})
})

describe("checkConclusion", () => {
	// Branch protection counts a neutral check as a pass, so there must never be one.
	test("is never neutral, whatever happened", () => {
		for (const o of Object.values(OUTCOMES)) {
			const c = checkConclusion(o)
			assert.notEqual(c, "neutral", `${o} produced a neutral check`)
			assert.ok(["success", "failure", "action_required"].includes(c), `${o} → ${c}`)
		}
	})

	test("passes only when the work actually succeeded", () => {
		assert.equal(checkConclusion(OUTCOMES.SUCCEEDED), "success")
	})

	test("fails when the tests did not pass", () => {
		assert.equal(checkConclusion(OUTCOMES.TESTS_FAILED), "failure")
	})

	test("asks for a person when the run could not finish", () => {
		assert.equal(checkConclusion(OUTCOMES.STOPPED_AT_LIMIT), "action_required")
		assert.equal(checkConclusion(OUTCOMES.COULD_NOT_RUN), "action_required")
	})
})

describe("stepShouldFail — build effect", () => {
	test("report leaves the step green whatever happened", () => {
		for (const o of Object.values(OUTCOMES)) {
			assert.equal(stepShouldFail("report", o), false, `${o} reddened the step under report`)
		}
	})

	test("off leaves the step green too", () => {
		assert.equal(stepShouldFail("off", OUTCOMES.TESTS_FAILED), false)
	})

	test("fail reddens the step on a bad outcome", () => {
		assert.equal(stepShouldFail("fail", OUTCOMES.TESTS_FAILED), true)
		assert.equal(stepShouldFail("fail", OUTCOMES.RUN_BROKE), true)
		assert.equal(stepShouldFail("fail", OUTCOMES.STOPPED_AT_LIMIT), true)
		assert.equal(stepShouldFail("fail", OUTCOMES.COULD_NOT_RUN), true)
	})

	test("fail still passes a successful run", () => {
		assert.equal(stepShouldFail("fail", OUTCOMES.SUCCEEDED), false)
	})

	test("anything unrecognised behaves as the default", () => {
		assert.equal(stepShouldFail(undefined, OUTCOMES.RUN_BROKE), true)
		assert.equal(stepShouldFail("FAIL_HARD", OUTCOMES.RUN_BROKE), true)
	})
})

describe("resolveOutcome — an unbound event is skipped, not broken", () => {
	test("exit 0 with outcome skipped is SKIPPED", () => {
		assert.equal(resolveOutcome(0, { outcome: "skipped" }), OUTCOMES.SKIPPED)
	})

	test("a plain exit 0 is still Succeeded", () => {
		assert.equal(resolveOutcome(0, { outcome: "succeeded" }), OUTCOMES.SUCCEEDED)
		assert.equal(resolveOutcome(0, {}), OUTCOMES.SUCCEEDED)
	})

	test("a real breakage at exit 0 is still Run broke", () => {
		assert.equal(resolveOutcome(0, { outcome: "broke" }), OUTCOMES.RUN_BROKE)
	})

	test("tests failing at exit 0 is still Tests failed", () => {
		assert.equal(resolveOutcome(0, { outcome: "failed" }), OUTCOMES.TESTS_FAILED)
	})

	test("a skipped outcome never reddens the step or the check", () => {
		assert.equal(stepShouldFail("fail", OUTCOMES.SKIPPED), false)
		assert.notEqual(checkConclusion(OUTCOMES.SKIPPED), "failure")
	})
})

// Approving a plan is spent by the run that carries it out — but only if a run actually happened.
describe("approvalWasSpent", () => {
	test("a run that succeeded spends it", () => {
		assert.equal(approvalWasSpent(OUTCOMES.SUCCEEDED), true)
	})

	test("failing tests still spend it", () => {
		assert.equal(approvalWasSpent(OUTCOMES.TESTS_FAILED), true)
	})

	// It ran, did part of the work, and may already have written some of it.
	test("stopping at a limit spends it", () => {
		assert.equal(approvalWasSpent(OUTCOMES.STOPPED_AT_LIMIT), true)
	})

	test("a run that broke does NOT spend it", () => {
		assert.equal(approvalWasSpent(OUTCOMES.RUN_BROKE), false)
	})

	test("a run that could not start does NOT spend it", () => {
		assert.equal(approvalWasSpent(OUTCOMES.COULD_NOT_RUN), false)
	})

	test("a skipped run does NOT spend it", () => {
		assert.equal(approvalWasSpent(OUTCOMES.SKIPPED), false)
	})

	test("every outcome has an answer", () => {
		for (const o of Object.values(OUTCOMES)) {
			assert.equal(typeof approvalWasSpent(o), "boolean", `${o} has no answer`)
		}
	})
})

describe("runDidNotWork — there is nothing to approve", () => {
	test("broke, never started, or hit a limit", () => {
		for (const o of [OUTCOMES.RUN_BROKE, OUTCOMES.COULD_NOT_RUN, OUTCOMES.STOPPED_AT_LIMIT]) assert.equal(runDidNotWork(o), true)
	})

	test("succeeded or failed tests is a real result", () => {
		assert.equal(runDidNotWork(OUTCOMES.SUCCEEDED), false)
		assert.equal(runDidNotWork(OUTCOMES.TESTS_FAILED), false)
	})
})
