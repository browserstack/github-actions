import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { OUTCOMES, parseSummary, resolveOutcome, checkConclusion, stepShouldFail } from "../src/outcome.mjs"

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

describe("checkConclusion — FR-48", () => {
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

describe("stepShouldFail — FR-9 build effect", () => {
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

	// An unset or misspelled build effect must not silently redden builds.
	test("anything unrecognised behaves as report", () => {
		assert.equal(stepShouldFail(undefined, OUTCOMES.RUN_BROKE), false)
		assert.equal(stepShouldFail("FAIL_HARD", OUTCOMES.RUN_BROKE), false)
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
		assert.equal(stepShouldFail(OUTCOMES.SKIPPED, "fail"), false)
		assert.notEqual(checkConclusion(OUTCOMES.SKIPPED), "failure")
	})
})
