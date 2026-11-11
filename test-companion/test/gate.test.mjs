import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { decideGate, GATE, describeChangeSize } from "../src/gate.mjs"
import { INTENT } from "../src/intent.mjs"

const asking = { kind: INTENT.WORKFLOW, workflow: "test", preview: false }
const go = { kind: INTENT.GO }
const fresh = { id: 7, expired: false }
const stale = { id: 7, expired: true }

describe("decideGate", () => {
	test("straight-through just runs", () => {
		assert.equal(decideGate({ intent: asking, approval: "straight-through" }).action, GATE.RUN)
	})

	test("review-before-run proposes instead of running", () => {
		assert.equal(decideGate({ intent: asking, approval: "review-before-run" }).action, GATE.PROPOSE)
	})

	test("a proposal run is always a preview run", () => {
		assert.equal(decideGate({ intent: asking, approval: "review-before-run" }).preview, true)
	})

	test('"go" on a waiting proposal runs it for real', () => {
		const d = decideGate({ intent: go, approval: "review-before-run", proposal: fresh })
		assert.equal(d.action, GATE.RUN)
		assert.equal(d.preview, false, "approving is the whole point; it must not stay a preview")
	})

	test('"go" on a proposal older than a day does not run it', () => {
		assert.equal(decideGate({ intent: go, approval: "review-before-run", proposal: stale }).action, GATE.EXPIRED)
	})

	test('"go" with nothing waiting says so rather than guessing', () => {
		assert.equal(decideGate({ intent: go, approval: "review-before-run" }).action, GATE.NOTHING_TO_APPROVE)
	})

	test('"go" on a straight-through repository has nothing to approve either', () => {
		assert.equal(decideGate({ intent: go, approval: "straight-through" }).action, GATE.NOTHING_TO_APPROVE)
	})

	test("an unknown approval setting holds for review", () => {
		assert.equal(decideGate({ intent: asking, approval: undefined }).action, GATE.PROPOSE)
		assert.equal(decideGate({ intent: asking, approval: "nonsense" }).action, GATE.PROPOSE)
	})

	test("asking for a preview explicitly is not held for approval", () => {
		const previewing = { kind: INTENT.WORKFLOW, workflow: "test", preview: true }
		const d = decideGate({ intent: previewing, approval: "review-before-run" })
		assert.equal(d.action, GATE.RUN)
		assert.equal(d.preview, true)
	})
})

describe("decideGate — who approved it", () => {
	test("approving your own proposal is flagged", () => {
		const d = decideGate({
			intent: { kind: INTENT.GO },
			approval: "review-before-run",
			proposal: { id: 7, expired: false, requester: "octocat" },
			actor: "octocat",
		})
		assert.equal(d.action, GATE.RUN)
		assert.equal(d.selfApproved, true)
	})

	test("a second pair of eyes is not flagged", () => {
		const d = decideGate({
			intent: { kind: INTENT.GO },
			approval: "review-before-run",
			proposal: { id: 7, expired: false, requester: "octocat" },
			actor: "an-sdet",
		})
		assert.equal(d.selfApproved, false)
	})

	test("an older proposal with no recorded requester is not claimed to be self-approved", () => {
		const d = decideGate({
			intent: { kind: INTENT.GO },
			approval: "review-before-run",
			proposal: { id: 7, expired: false },
			actor: "octocat",
		})
		assert.equal(d.selfApproved, false)
	})
})

describe("a very large change", () => {
	test("an ordinary change is not large", () => {
		assert.equal(describeChangeSize({ changed_files: 3, additions: 40, deletions: 10 }).large, false)
	})

	test("more than twenty files is large", () => {
		assert.equal(describeChangeSize({ changed_files: 21, additions: 1, deletions: 0 }).large, true)
	})

	test("exactly twenty files is not", () => {
		assert.equal(describeChangeSize({ changed_files: 20, additions: 1, deletions: 0 }).large, false)
	})

	test("more than a thousand changed lines is large, counting both directions", () => {
		assert.equal(describeChangeSize({ changed_files: 2, additions: 600, deletions: 401 }).large, true)
		assert.equal(describeChangeSize({ changed_files: 2, additions: 600, deletions: 400 }).large, false)
	})

	test("it reports the numbers, so the proposal can say why", () => {
		const d = describeChangeSize({ changed_files: 30, additions: 900, deletions: 200 })
		assert.equal(d.files, 30)
		assert.equal(d.lines, 1100)
	})

	test("an unreadable pull request is not assumed to be large", () => {
		assert.equal(describeChangeSize(undefined).large, false)
		assert.equal(describeChangeSize({}).large, false)
	})
})

describe("decideGate — a job that only answers does not ask permission first", () => {
	const asked = { kind: INTENT.WORKFLOW }

	test("rca and verdict run straight away, even with approval required", () => {
		for (const workflow of ["rca", "verdict"]) {
			const got = decideGate({ intent: asked, approval: "review-before-run", workflow })
			assert.equal(got.action, GATE.RUN, `${workflow} writes nothing; holding it asks permission to write nothing`)
			assert.equal(got.preview, true, `an unapproved ${workflow} must not get write tools`)
		}
	})

	test("everything that CAN write still waits", () => {
		for (const workflow of ["generate", "fix", "test-pr", "automate", undefined]) {
			const got = decideGate({ intent: asked, approval: "review-before-run", workflow })
			assert.equal(got.action, GATE.PROPOSE, `${workflow} can write, so it must still be reviewed`)
		}
	})

	test("an explicit preview request is still honoured for them", () => {
		const got = decideGate({ intent: { kind: INTENT.WORKFLOW, preview: true }, approval: "review-before-run", workflow: "rca" })
		assert.equal(got.action, GATE.RUN)
		assert.equal(got.preview, true, "asking for a preview must not be overridden by this")
	})
})
