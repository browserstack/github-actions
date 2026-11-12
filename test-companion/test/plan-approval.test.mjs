import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
	findProposal,
	planSpentState,
	proposalConsumedMarkerFor,
	proposalDroppedMarkerFor,
	proposalMarkerFor,
} from "../src/report.mjs"

const US = "browserstack[bot]"
const SHA = "abc1234"
const now = Date.parse("2026-11-12T12:00:00Z")
const fresh = "2026-11-12T11:00:00Z"
const plan = (id, workflow = "generate", extra = "") => ({
	id,
	user: { type: "Bot", login: US },
	created_at: fresh,
	html_url: `https://x/${id}`,
	body: `the plan ${id}${extra}\n\n${proposalMarkerFor(SHA, "alice", workflow)}`,
})
const ours = (id, body) => ({ id, user: { type: "Bot", login: US }, created_at: fresh, body })

describe("go approves the newest unspent plan", () => {
	test("a spent plan for the same job and commit doesn't block a newer one", () => {
		const comments = [plan(10, "generate", `\n${proposalConsumedMarkerFor(SHA, "generate", 10)}`), plan(20)]
		assert.equal(findProposal(comments, SHA, now, US)?.id, 20)
	})

	test("the spent plan itself is not approvable again", () => {
		const comments = [plan(10, "generate", `\n${proposalConsumedMarkerFor(SHA, "generate", 10)}`)]
		assert.equal(findProposal(comments, SHA, now, US), undefined)
		assert.equal(findProposal(comments, SHA, now, US, { id: 10 }), undefined)
	})

	test("a marker on the run report names the plan, so other plans stay open", () => {
		const comments = [plan(10), plan(20), ours(30, `report\n${proposalConsumedMarkerFor(SHA, "generate", 10)}`)]
		assert.equal(findProposal(comments, SHA, now, US)?.id, 20)
		assert.equal(findProposal(comments, SHA, now, US, { id: 20 })?.id, 20)
	})

	test("an old marker without a plan id spends only plans posted before it", () => {
		const comments = [plan(10), ours(15, `ran it\n${proposalConsumedMarkerFor(SHA, "generate")}`), plan(20)]
		assert.equal(findProposal(comments, SHA, now, US)?.id, 20)
		assert.equal(findProposal(comments, SHA, now, US, { id: 10 }), undefined)
	})

	test("an old marker without a job still covers earlier plans of every job", () => {
		const comments = [plan(10, "fix"), ours(15, proposalConsumedMarkerFor(SHA)), plan(20, "fix")]
		assert.equal(findProposal(comments, SHA, now, US, { id: 10 }), undefined)
		assert.equal(findProposal(comments, SHA, now, US)?.id, 20)
	})

	test("a dropped marker with a plan id drops only that plan", () => {
		const comments = [plan(10), ours(12, `dropped\n${proposalDroppedMarkerFor(SHA, "generate", 10)}`), plan(20)]
		assert.equal(findProposal(comments, SHA, now, US)?.id, 20)
	})

	test("a marker another account posted counts for nothing", () => {
		const forged = { id: 25, user: { type: "Bot", login: "other[bot]" }, body: proposalConsumedMarkerFor(SHA, "generate", 20) }
		assert.equal(findProposal([plan(20), forged], SHA, now, US)?.id, 20)
	})
})

describe("planSpentState", () => {
	test("says whether a named plan was approved or dropped", () => {
		const comments = [
			plan(10, "generate", `\n${proposalConsumedMarkerFor(SHA, "generate", 10)}`),
			plan(20),
			ours(22, proposalDroppedMarkerFor(SHA, "generate", 20)),
			plan(30),
		]
		assert.equal(planSpentState(comments, 10, US), "approved")
		assert.equal(planSpentState(comments, "20", US), "dropped")
		assert.equal(planSpentState(comments, 30, US), undefined)
		assert.equal(planSpentState(comments, 99, US), undefined)
	})

	test("markers carry only digits for the plan id", () => {
		assert.match(proposalConsumedMarkerFor(SHA, "fix", "12x3"), / plan=123 -->$/)
		assert.doesNotMatch(proposalConsumedMarkerFor(SHA, "fix"), /plan=/)
	})
})
