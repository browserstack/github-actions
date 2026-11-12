import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { requestLink, askedByCell } from "../src/report.mjs"

describe("requestLink: the report names the comment that asked for it", () => {
	test("a comment link becomes its id, linked", () => {
		const url = "https://github.com/o/r/pull/945#issuecomment-6830219211"
		assert.equal(requestLink(url), `[#6830219211](${url})`)
	})

	test("anything that isn't a comment link gives no row", () => {
		assert.equal(requestLink(undefined), "")
		assert.equal(requestLink(""), "")
		assert.equal(requestLink("https://github.com/o/r/pull/945"), "")
		assert.equal(requestLink("https://github.com/o/r/pull/945#issuecomment-12) [x](https://evil.example"), "")
		assert.equal(requestLink("javascript:alert(1)#issuecomment-1"), "")
	})
})


describe("askedByCell", () => {
	test("who and the linked comment id, pipe escaped", () => {
		const url = "https://github.com/o/r/pull/9#issuecomment-123"
		assert.equal(askedByCell("octocat", url), `@octocat \\| [#123](${url})`)
	})
	test("no comment link: just who", () => {
		assert.equal(askedByCell("octocat", undefined), "@octocat")
		assert.equal(askedByCell("octocat", "https://github.com/o/r/pull/9"), "@octocat")
	})
	test("nobody asked: empty, so the row is dropped", () => {
		assert.equal(askedByCell(undefined, "https://github.com/o/r/pull/9#issuecomment-1"), "")
	})
})

describe("requestLink rejects table and markdown breakers", () => {
	test("a pipe or bracket in the URL gives no link", () => {
		assert.equal(requestLink("https://github.com/o/r|x/pull/9#issuecomment-1"), "")
		assert.equal(requestLink("https://github.com/o/r]x/pull/9#issuecomment-1"), "")
	})
})
