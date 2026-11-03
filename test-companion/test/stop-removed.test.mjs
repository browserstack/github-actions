import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readIntent, INTENT, CAPABILITIES } from "../src/intent.mjs"
import { renderProposal, renderStopRemoved, renderUnknownRequest } from "../src/report.mjs"

/**
 * `stop` is gone — STM-5434 demo feedback, item 7.
 *
 * It did two things: cancelled a run in flight, and dropped a plan waiting for
 * approval. Neither survives. GitHub's own cancel button ends a run, and a plan
 * nobody answers expires by itself after a day.
 *
 * The WORD is still recognised, because proposals already sitting in live
 * threads tell people to say it. Answering those with "that did not name
 * anything I can do" would be true and useless.
 */

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
		// Both halves of what it used to do, so nobody is left guessing about
		// the plan they were trying to drop.
		assert.match(said, /24 hours|a day/i)
	})

	test("a proposal no longer tells people to say it", () => {
		const body = renderProposal("the plan", "abc123", "dev", "fix")
		assert.doesNotMatch(body, /\bstop\b/i)
		// What a proposal DOES still say must survive the edit.
		assert.match(body, /\bgo\b/)
	})
})

describe("the starter workflow keeps the control lane for closed pull requests", () => {
	const starter = readFileSync(new URL("../starter-workflow.yml", import.meta.url), "utf8")
	const group = starter.slice(starter.indexOf("concurrency:"), starter.indexOf("\njobs:"))

	/**
	 * CHANGED by the review of #3286. Taking `stop` out of the lane put it in
	 * the WORK group, which has `cancel-in-progress: false` and keeps only one
	 * pending run — so a `stop` comment could evict a queued `go`, and all it
	 * does now is reply. The lane is cheap; the eviction is not.
	 */
	test("a stop comment keeps its own lane, so it cannot evict a queued run", () => {
		assert.match(group, /'stop'/)
	})

	/**
	 * The feedback said the `-control` suffix "exists only so a stop comment
	 * lands in a separate lane". It does not: a CLOSED pull request is a
	 * control event too, and cancelling its run is FR-36, which stays. Removing
	 * the suffix outright would put that cancel back in the queue behind the
	 * very run it is sent to end — blocker B2, reintroduced.
	 */
	test("a closed pull request still gets one", () => {
		assert.match(group, /github\.event\.action == 'closed'/)
		assert.match(group, /-control/)
	})

	test("work runs still queue rather than cancel each other", () => {
		assert.match(group, /cancel-in-progress:\s*false/)
	})
})
