import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { findTicket } from "../src/ticket.mjs"

describe("findTicket — FR-37", () => {
	test("from the branch, which is where it usually is", () => {
		assert.equal(findTicket({ branch: "feat/SHOP-221-add-discount-code" }), "SHOP-221")
	})

	test("from the title", () => {
		assert.equal(findTicket({ title: "SHOP-221: discount codes at checkout" }), "SHOP-221")
	})

	test("from the description", () => {
		assert.equal(findTicket({ body: "Implements SHOP-221.\n\nSee the spec." }), "SHOP-221")
	})

	test("the title wins, because a person wrote it most recently", () => {
		assert.equal(findTicket({ title: "SHOP-9: the real one", branch: "feat/SHOP-221-old" }), "SHOP-9")
	})

	/**
	 * The trap. A Jira key and a standards reference are the same shape, so a
	 * naive pattern turns "upgrade to UTF-8" into a run that tests against
	 * ticket UTF-8 and reports it confidently in the first comment.
	 */
	test("a standards reference is not a ticket", () => {
		for (const text of [
			"switch to UTF-8",
			"use SHA-256",
			"move to HTTP-2",
			"per RFC-3339",
			"ISO-8601 dates",
			"AES-256 at rest",
		]) {
			assert.equal(findTicket({ title: text }), undefined, `"${text}" must not read as a ticket`)
		}
	})

	test("a CVE is not a ticket either", () => {
		assert.equal(findTicket({ title: "patch CVE-2026-1234" }), undefined)
	})

	test("a single letter is not a project key", () => {
		assert.equal(findTicket({ title: "bump to X-1" }), undefined)
	})

	test("lowercase is not a ticket key", () => {
		assert.equal(findTicket({ branch: "feat/shop-221-thing" }), undefined)
	})

	test("nothing to find is undefined", () => {
		assert.equal(findTicket({ title: "fix the footer", branch: "fix/footer" }), undefined)
		assert.equal(findTicket({}), undefined)
		assert.equal(findTicket(), undefined)
	})

	test("the first key wins when a title names several", () => {
		assert.equal(findTicket({ title: "SHOP-221 and SHOP-222" }), "SHOP-221")
	})

	// The lookbehind makes the match start at the X, so this reads as the
	// project XSHOP — which is a perfectly good key — rather than quietly
	// slicing SHOP-221 out of the middle of a word.
	test("a longer project key is read whole, not sliced", () => {
		assert.equal(findTicket({ title: "XSHOP-221" }), "XSHOP-221")
	})

	test("a real key behind a false positive is still found", () => {
		assert.equal(findTicket({ title: "UTF-8 fixes for SHOP-221" }), "SHOP-221")
	})
})
