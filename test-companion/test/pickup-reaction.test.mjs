import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { pickupReactionTarget, addPickupReaction } from "../src/access.mjs"

const person = { id: 123456, user: { login: "dev", type: "User" } }
const request = { event: "pr_comment", approvalOnly: false }
const bareGo = { event: "pr_comment", approvalOnly: true }
const base = { eventName: "issue_comment", comment: person, plan: request, allowed: true }

describe("pickupReactionTarget — which comment gets 👀", () => {
	test("an accepted @browserstack request", () => {
		assert.equal(pickupReactionTarget(base), 123456)
	})

	test("an accepted go with a plan waiting", () => {
		assert.equal(pickupReactionTarget({ ...base, plan: bareGo, approvalHasPlan: true }), 123456)
	})

	test("a bare go with no plan to approve is ignored, so no reaction", () => {
		assert.equal(pickupReactionTarget({ ...base, plan: bareGo, approvalHasPlan: false }), undefined)
		assert.equal(pickupReactionTarget({ ...base, plan: bareGo }), undefined)
	})

	test("never a bot's comment", () => {
		assert.equal(pickupReactionTarget({ ...base, comment: { id: 1, user: { login: "browserstack[bot]", type: "Bot" } } }), undefined)
		assert.equal(pickupReactionTarget({ ...base, comment: { id: 1, user: { login: "renovate[bot]", type: "User" } } }), undefined)
	})

	test("never a refused comment (no write access)", () => {
		assert.equal(pickupReactionTarget({ ...base, allowed: false }), undefined)
		assert.equal(pickupReactionTarget({ ...base, allowed: undefined }), undefined)
	})

	test("never a comment that wasn't addressed to us", () => {
		assert.equal(pickupReactionTarget({ ...base, plan: { skip: "not-addressed-to-us" } }), undefined)
		assert.equal(pickupReactionTarget({ ...base, plan: undefined }), undefined)
	})

	test("never outside a pull request comment", () => {
		assert.equal(pickupReactionTarget({ ...base, eventName: "pull_request" }), undefined)
		assert.equal(pickupReactionTarget({ ...base, plan: { event: "pr_opened" } }), undefined)
	})

	test("no usable comment id, no reaction", () => {
		assert.equal(pickupReactionTarget({ ...base, comment: { user: person.user } }), undefined)
		assert.equal(pickupReactionTarget({ ...base, comment: { id: "abc", user: person.user } }), undefined)
		assert.equal(pickupReactionTarget({ ...base, comment: { id: -5, user: person.user } }), undefined)
	})
})

describe("addPickupReaction — best effort", () => {
	test("posts eyes to the comment's reactions", () => {
		const calls = []
		const ok = addPickupReaction({ repo: "o/r", commentId: 42, post: (path, body) => (calls.push([path, body]), true) })
		assert.equal(ok, true)
		assert.deepEqual(calls, [["repos/o/r/issues/comments/42/reactions", { content: "eyes" }]])
	})

	test("a refused call (403/404) returns false, never throws", () => {
		assert.equal(addPickupReaction({ repo: "o/r", commentId: 42, post: () => false }), false)
	})

	test("a thrown error (network) returns false, never throws", () => {
		assert.equal(
			addPickupReaction({
				repo: "o/r",
				commentId: 42,
				post: () => {
					throw new Error("ECONNRESET")
				},
			}),
			false,
		)
	})

	test("nothing to react to, no call", () => {
		let called = false
		assert.equal(addPickupReaction({ repo: "o/r", commentId: undefined, post: () => (called = true) }), false)
		assert.equal(called, false)
	})
})
