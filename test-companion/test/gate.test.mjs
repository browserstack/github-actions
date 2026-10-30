import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { decideGate, GATE, describeChangeSize } from "../src/gate.mjs"
import { INTENT } from "../src/intent.mjs"

const asking = { kind: INTENT.WORKFLOW, workflow: "test", preview: false }
const go = { kind: INTENT.GO }
const fresh = { id: 7, expired: false }
const stale = { id: 7, expired: true }

describe("decideGate — FR-43", () => {
	test("straight-through just runs", () => {
		assert.equal(decideGate({ intent: asking, approval: "straight-through" }).action, GATE.RUN)
	})

	/**
	 * FR-43: "the run SHALL post its proposal and end. Nothing SHALL be written
	 * before 'go'." The proposal run is a PREVIEW run — preview is already
	 * enforced in tool dispatch as of Release 1, so "nothing is written" is a
	 * property of the run rather than a promise in a prompt.
	 */
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

	test('"go" on a proposal older than a day does not run it — FR-44', () => {
		assert.equal(decideGate({ intent: go, approval: "review-before-run", proposal: stale }).action, GATE.EXPIRED)
	})

	test('"go" with nothing waiting says so rather than guessing', () => {
		assert.equal(decideGate({ intent: go, approval: "review-before-run" }).action, GATE.NOTHING_TO_APPROVE)
	})

	// Nothing was ever held, so there is nothing to approve. Running on the
	// strength of "go" alone would start a job nobody named.
	test('"go" on a straight-through repository has nothing to approve either', () => {
		assert.equal(decideGate({ intent: go, approval: "straight-through" }).action, GATE.NOTHING_TO_APPROVE)
	})

	/**
	 * Fails CLOSED. An approval value that never went through the CLI's
	 * validation — or a bindings read that failed — holds for review rather
	 * than running unreviewed, matching ResolvedApproval on the Go side.
	 */
	test("an unknown approval setting holds for review", () => {
		assert.equal(decideGate({ intent: asking, approval: undefined }).action, GATE.PROPOSE)
		assert.equal(decideGate({ intent: asking, approval: "nonsense" }).action, GATE.PROPOSE)
	})

	test("asking for a preview explicitly is not held for approval", () => {
		// They already asked for the safe thing; holding it for review would be
		// asking permission to write nothing.
		const previewing = { kind: INTENT.WORKFLOW, workflow: "test", preview: true }
		const d = decideGate({ intent: previewing, approval: "review-before-run" })
		assert.equal(d.action, GATE.RUN)
		assert.equal(d.preview, true)
	})
})

describe("decideGate — who approved it — FR-43", () => {
	/**
	 * Both the asker and the approver need write access, so this is not a
	 * privilege boundary — it is a workflow-integrity signal. FR-43's user story
	 * has an SDET approving a developer's request; the normative text only says
	 * "someone who can ask". So self-approval is allowed and REPORTED, rather
	 * than silently permitted or blocked outright (blocking would strand a solo
	 * maintainer, who could then never approve anything).
	 */
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

describe("a very large change — FR-44", () => {
	// FR-44's thresholds, marked ASSUMPTION in the PRD: more than 20 files or
	// more than 1,000 changed lines.
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

	// A pull request object we could not read must not be called large; the
	// consequence would be telling every reviewer their change is too big.
	test("an unreadable pull request is not assumed to be large", () => {
		assert.equal(describeChangeSize(undefined).large, false)
		assert.equal(describeChangeSize({}).large, false)
	})
})

/**
 * Asking "why did this fail?" cost two comments and a round trip: the first
 * run posted an empty proposal — empty because only `test-pr` has a plan to
 * show — and the answer only came after someone replied "go". Seen on live
 * runs 41048492170 and 41049253928.
 *
 * The gate exists to stop WRITES. `rca` and `verdict` produce an explanation
 * and nothing else, which is the same reasoning already applied one line
 * above for a preview that was asked for directly.
 */
describe("decideGate — a job that only answers does not ask permission first", () => {
	const asked = { kind: INTENT.WORKFLOW }

	test("rca and verdict run straight away, even with approval required", () => {
		for (const workflow of ["rca", "verdict"]) {
			const got = decideGate({ intent: asked, approval: "review-before-run", workflow })
			assert.equal(got.action, GATE.RUN, `${workflow} writes nothing; holding it asks permission to write nothing`)
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
