import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { OUTCOMES, emojiFor } from "../src/outcome.mjs"
import { renderJobSummary } from "../src/report.mjs"

/**
 * The outcome should be readable at a glance.
 *
 * "## Test Companion — Run broke" and "## Test Companion — Succeeded" look the
 * same in a crowded pull request thread, and the one that needs attention is
 * the one that blends in.
 */

describe("every outcome has a mark of its own", () => {
	test("no two outcomes share one", () => {
		const marks = Object.values(OUTCOMES).map(emojiFor)
		assert.equal(new Set(marks).size, marks.length, `marks collide: ${marks.join(" ")}`)
	})

	test("every outcome has one", () => {
		for (const o of Object.values(OUTCOMES)) {
			assert.ok(emojiFor(o), `${o} has no mark`)
		}
	})

	test("an outcome we do not know does not break the heading", () => {
		// A newer CLI could report something this Action has never heard of.
		// A missing mark is a cosmetic loss; a crash is a lost report.
		assert.equal(emojiFor("Something new"), "")
		assert.equal(emojiFor(undefined), "")
	})

	test("the heading carries it", () => {
		const body = renderJobSummary({ workflow: "fix", outcome: OUTCOMES.RUN_BROKE, summary: {}, runUrl: "https://run" })
		assert.match(body.split("\n")[0], /^## Test Companion — .+ Run broke$/u)
		assert.ok(body.split("\n")[0].includes(emojiFor(OUTCOMES.RUN_BROKE)))
	})

	test("and so does the row, so the table reads on its own", () => {
		const body = renderJobSummary({ workflow: "fix", outcome: OUTCOMES.TESTS_FAILED, summary: {}, runUrl: "https://run" })
		assert.match(body, new RegExp(`\\| Outcome \\| ${emojiFor(OUTCOMES.TESTS_FAILED)} Tests failed \\|`, "u"))
	})

	test("a success still reads as a success", () => {
		const body = renderJobSummary({ workflow: "generate", outcome: OUTCOMES.SUCCEEDED, summary: {}, runUrl: "https://run" })
		assert.match(body.split("\n")[0], /Succeeded$/)
	})
})
