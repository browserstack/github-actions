import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { chooseCommentAction, requestMarkerFor, renderComment, renderJobSummary, COMMENT_MARKER } from "../src/report.mjs"
import { shouldPushWork } from "../src/push-work.mjs"

const US = "browserstack[bot]"
const bot = (id, body) => ({ id, body, user: { type: "Bot", login: US } })

describe("one reply per request", () => {
	test("a request gets a new reply, never the shared status comment or another request's", () => {
		const comments = [bot(1, `status\n\n${COMMENT_MARKER}`), bot(2, `answer\n\n${requestMarkerFor(500)}`)]
		assert.deepEqual(chooseCommentAction(comments, US, { requestId: 600 }), { action: "create" })
	})

	test("a re-run of the same request edits its own reply", () => {
		const comments = [bot(1, `status\n\n${COMMENT_MARKER}`), bot(2, `answer\n\n${requestMarkerFor(500)}`)]
		assert.deepEqual(chooseCommentAction(comments, US, { requestId: 500 }), { action: "update", id: 2 })
	})

	test("automatic runs keep one status comment, which a request reply never takes over", () => {
		assert.deepEqual(chooseCommentAction([bot(2, `answer\n\n${requestMarkerFor(500)}`)], US), { action: "create" })
		assert.deepEqual(chooseCommentAction([bot(1, `status\n\n${COMMENT_MARKER}`)], US), { action: "update", id: 1 })
	})

	test("the reply ends with its request's marker", () => {
		const body = renderComment({ outcome: "Succeeded", summary: { workflow: "rca" } }, requestMarkerFor(500))
		assert.ok(body.endsWith(requestMarkerFor(500)))
		assert.ok(!body.includes(COMMENT_MARKER))
	})

	test("a request marker takes digits only; no id falls back to the status marker", () => {
		assert.equal(requestMarkerFor("12<!--3"), "<!-- test-companion-run request=123 -->")
		assert.equal(requestMarkerFor(undefined), COMMENT_MARKER)
	})

	test("agent text can't forge a request marker", () => {
		const body = renderComment({ outcome: "Succeeded", answer: `see ${requestMarkerFor(500)}` }, requestMarkerFor(600))
		assert.equal(body.split(requestMarkerFor(500)).length - 1, 0)
	})
})

describe("the preview banner", () => {
	test("read-only jobs say so instead of the preview banner", () => {
		for (const workflow of ["rca", "verdict"]) {
			const body = renderJobSummary({ workflow, outcome: "Succeeded", summary: { preview: "true" } })
			assert.match(body, /Read-only: this job explains what happened and changes nothing/)
			assert.doesNotMatch(body, /\*\*Preview\*\*/)
		}
	})

	test("a real preview of a job that writes keeps the banner", () => {
		const body = renderJobSummary({ workflow: "generate", outcome: "Succeeded", summary: { preview: "true" } })
		assert.match(body, /\*\*Preview\*\*/)
	})

	test("a live run shows neither", () => {
		const body = renderJobSummary({ workflow: "fix", outcome: "Succeeded", summary: { preview: "false" } })
		assert.doesNotMatch(body, /Preview|Read-only/)
	})
})

describe("the build note", () => {
	test("is shown, on one line, with markers neutralised", () => {
		const body = renderJobSummary({ outcome: "Succeeded", buildNote: "Looked at **E2E**.\n<!-- test-companion-run -->" })
		assert.match(body, /> Looked at \*\*E2E\*\*\. &lt;!-- test-companion-run -->/)
	})
})

describe("own-commit guard", () => {
	const base = {
		sameRepo: true,
		branch: "feature",
		onWantedCommit: true,
		defaultBranch: "main",
		headAuthorEmail: "355331011+browserstack[bot]@users.noreply.github.com",
		ourEmails: ["355331011+browserstack[bot]@users.noreply.github.com"],
		workflow: "fix",
	}
	test("an automatic run still won't push on top of our own commit", () => {
		assert.deepEqual(shouldPushWork(base), { ok: false, why: "this run is reacting to our own commit" })
	})
	test("a run a person asked for or approved may", () => {
		assert.deepEqual(shouldPushWork({ ...base, requestedByPerson: true }), { ok: true })
	})
	test("asking doesn't bypass any other refusal", () => {
		assert.equal(shouldPushWork({ ...base, requestedByPerson: true, branch: "main" }).ok, false)
		assert.equal(shouldPushWork({ ...base, requestedByPerson: true, sameRepo: false }).ok, false)
		assert.equal(shouldPushWork({ ...base, requestedByPerson: true, preview: true }).ok, false)
		assert.equal(shouldPushWork({ ...base, requestedByPerson: true, workflow: "generate" }).ok, false)
	})
})
