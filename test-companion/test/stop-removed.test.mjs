import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readIntent, INTENT, CAPABILITIES } from "../src/intent.mjs"
import { renderProposal, renderStopRemoved, renderUnknownRequest } from "../src/report.mjs"

describe("stop no longer does anything", () => {
	test("the word is still understood", () => {
		assert.equal(readIntent("stop").kind, INTENT.STOP)
	})

	test("it is no longer offered as something to ask for", () => {
		assert.equal(
			CAPABILITIES.some((c) => c.ask === "stop"),
			false,
		)
		assert.doesNotMatch(renderUnknownRequest(), /\*\*stop\*\*/)
	})

	test("the reply says what to do instead", () => {
		const said = renderStopRemoved()
		assert.match(said, /cancel/i)
		assert.match(said, /24 hours|a day/i)
	})

	test("a proposal no longer tells people to say it", () => {
		const body = renderProposal("the plan", "abc123", "dev", "fix")
		assert.doesNotMatch(body, /\bstop\b/i)
		// What a proposal does still say must survive the edit.
		assert.match(body, /\bgo\b/)
	})
})

describe("the starter workflow keeps the control lane for closed pull requests", () => {
	const starter = readFileSync(new URL("../starter-workflow.yml", import.meta.url), "utf8")
	const group = starter.slice(starter.indexOf("concurrency:"), starter.indexOf("\njobs:"))

	test("a stop comment keeps its own lane, so it cannot evict a queued run", () => {
		assert.match(group, /startsWith\(github\.event\.comment\.body, '@browserstack stop'\)/)
	})

	test("only a comment that starts with the stop request takes the lane", () => {
		assert.doesNotMatch(group, /contains\(github\.event\.comment\.body, 'stop'\)/)
	})

	test("a closed pull request still gets one", () => {
		assert.match(group, /github\.event\.action == 'closed'/)
		assert.match(group, /-control/)
	})

	test("work runs still queue rather than cancel each other", () => {
		assert.match(group, /cancel-in-progress:\s*false/)
	})
})
