import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { OUTCOMES, parseSummary, resolveOutcome, checkConclusion, stepShouldFail, approvalWasSpent } from "../src/outcome.mjs"

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

	// Exit 4 covers three different causes. Only the report distinguishes a
	// ceiling from a crash, which is why the Action reads both.
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

	// The observed false green: an expired session ended with status completed
	// and exit 0 having done nothing. If the CLI said it could not run, believe
	// the report over the exit code.
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

	// A run that could not finish must not be able to satisfy a required check,
	// but it is not the same as a test failure — someone has to do something.
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

	// REVERSED by. While `report` was the
	// default, "a misconfiguration must never redden a build" was the safe
	// direction. The default is now fail-on-break, so a typo landing you on a
	// quieter setting than a fresh install is the silent pass item 6 is about.
	// The whole rule lives in build-effect.test.mjs now; this is the hinge.
	test("anything unrecognised behaves as the default", () => {
		assert.equal(stepShouldFail(undefined, OUTCOMES.RUN_BROKE), true)
		assert.equal(stepShouldFail("FAIL_HARD", OUTCOMES.RUN_BROKE), true)
	})
})

// P0 from review: an event nothing is bound to must not look like a failure.
//
// The CLI now exits 0 and writes `outcome: skipped` for an unbound event. The
// old code took exit 0 with any non-"succeeded" outcome as RUN_BROKE, so this
// would have gone from one wrong answer to another.
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
		// The arguments were the wrong way round here, which made this pass
		// without ever asking the question. stepShouldFail(buildEffect, outcome).
		assert.equal(stepShouldFail("fail", OUTCOMES.SKIPPED), false)
		assert.notEqual(checkConclusion(OUTCOMES.SKIPPED), "failure")
	})
})

/**
 * Approving a plan is spent by the run that carries it out — but only if a run
 * actually happened.
 *
 * Found live: an approved `fix` died in under a second before doing any work
 * (the dedupe claim had no credential, run 41463749519), and the result comment
 * still carried the consumed marker. Every later `go` on that commit was then
 * refused — "already been approved and run on this commit" — including after a
 * fresh proposal was put up. The only way out was a new commit.
 *
 * The dedupe claim already has this property: it releases itself on a
 * non-success outcome. An approval should behave the same way.
 */
describe("approvalWasSpent", () => {
	test("a run that succeeded spends it", () => {
		assert.equal(approvalWasSpent(OUTCOMES.SUCCEEDED), true)
	})

	// The run did the work it was approved for. Red tests are a result, not a
	// failure to run — re-running would redo the work and charge for it again.
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

	// Totality: a new outcome must be considered rather than silently spending
	// an approval because it is not one of the two named failures.
	test("every outcome has an answer", () => {
		for (const o of Object.values(OUTCOMES)) {
			assert.equal(typeof approvalWasSpent(o), "boolean", `${o} has no answer`)
		}
	})
})
