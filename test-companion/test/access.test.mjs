import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { mayAsk } from "../src/access.mjs"

describe("mayAsk", () => {
	test("write access is enough when no team is named", () => {
		assert.equal(mayAsk({ hasWriteAccess: true }), true)
	})

	test("without write access, nothing else matters", () => {
		assert.equal(mayAsk({ hasWriteAccess: false }), false)
	})

	test("being on the team does not widen past write access", () => {
		assert.equal(mayAsk({ hasWriteAccess: false, askTeam: "qa-leads", inTeam: true }), false)
	})

	test("with a team named, a member may ask", () => {
		assert.equal(mayAsk({ hasWriteAccess: true, askTeam: "qa-leads", inTeam: true }), true)
	})

	test("with a team named, a non-member may not", () => {
		assert.equal(mayAsk({ hasWriteAccess: true, askTeam: "qa-leads", inTeam: false }), false)
	})

	test("an unanswerable membership question is a no", () => {
		assert.equal(mayAsk({ hasWriteAccess: true, askTeam: "qa-leads", inTeam: undefined }), false)
		assert.equal(mayAsk({ hasWriteAccess: true, askTeam: "qa-leads", inTeam: null }), false)
	})

	test("an empty team name is no narrowing at all", () => {
		assert.equal(mayAsk({ hasWriteAccess: true, askTeam: "", inTeam: false }), true)
		assert.equal(mayAsk({ hasWriteAccess: true, askTeam: "   ", inTeam: false }), true)
	})
})

import { describeTestRepoAccess } from "../src/access.mjs"

describe("describeTestRepoAccess", () => {
	test("no separate repository means this one, which always works", () => {
		assert.equal(describeTestRepoAccess({ thisRepo: "acme/shop" }).ok, true)
		assert.equal(describeTestRepoAccess({ testsRepo: "acme/shop", thisRepo: "acme/shop" }).ok, true)
	})

	test("a separate repository we can push to is fine", () => {
		assert.equal(describeTestRepoAccess({ testsRepo: "acme/shop-tests", thisRepo: "acme/shop", canPush: true }).ok, true)
	})

	test("without access, it says so and names both ways to fix it", () => {
		const d = describeTestRepoAccess({ testsRepo: "acme/shop-tests", thisRepo: "acme/shop", canPush: false })
		assert.equal(d.ok, false)
		assert.match(d.message, /acme\/shop-tests/)
		assert.match(d.message, /App/)
		assert.match(d.message, /token/i)
	})

	test("an unanswerable question is a no", () => {
		assert.equal(describeTestRepoAccess({ testsRepo: "acme/shop-tests", thisRepo: "acme/shop" }).ok, false)
	})

	test("case differences are the same repository", () => {
		assert.equal(describeTestRepoAccess({ testsRepo: "Acme/Shop", thisRepo: "acme/shop" }).ok, true)
	})
})
