import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readIntent, INTENT } from "../src/intent.mjs"
import { planRun } from "../src/plan-run.mjs"
import {
	hasApproverEdits,
	renderApprovedPlan,
	proposalMarkerFor,
	proposalConsumedMarkerFor,
	proposalDroppedMarkerFor,
	proposalAlreadyUsed,
	proposalNeedsDropping,
	findProposal,
	renderJobSummary,
} from "../src/report.mjs"
import { OUTCOMES } from "../src/outcome.mjs"

/**
 * "go" should say which request it is answering.
 *
 * Two problems, one cause: the approval machinery was keyed on the COMMIT and
 * nothing else. With two plans waiting there was nothing in what you typed to
 * pick one, and the record of which plans had been used could not tell two
 * jobs apart — so approving one blocked approving any other on that commit
 * until somebody pushed.
 */

const US = "test-companion[bot]"
const SHA = "abc123def4567890"
const now = Date.parse("2026-11-03T12:00:00Z")
const fresh = "2026-11-03T11:00:00Z"

/** A proposal comment from us, for one job. */
const proposal = (id, workflow, { requester = "dev", sha = SHA, at = fresh } = {}) => ({
	id,
	user: { type: "Bot", login: US },
	created_at: at,
	html_url: `https://github.com/o/r/pull/1#issuecomment-${id}`,
	body: `Here is the plan.\n\n${proposalMarkerFor(sha, requester, workflow)}`,
})

/** Our own comment recording that a plan was spent. */
const consumed = (id, workflow, sha = SHA) => ({
	id,
	user: { type: "Bot", login: US },
	created_at: fresh,
	body: `Done.\n${proposalConsumedMarkerFor(sha, workflow)}`,
})

describe("go can name the plan it answers", () => {
	test("bare go takes the most recent plan still waiting", () => {
		const comments = [proposal(1001, "generate"), proposal(1002, "fix")]
		assert.equal(findProposal(comments, SHA, now, US)?.id, 1002)
	})

	test("go #id takes the plan that was named, not the newest", () => {
		const comments = [proposal(1001, "generate"), proposal(1002, "fix")]
		const got = findProposal(comments, SHA, now, US, { id: 1001 })
		assert.equal(got?.id, 1001)
		assert.equal(got?.workflow, "generate")
	})

	test("the intent carries the id a reply named", () => {
		// What readIntent actually receives: plan-run.mjs strips the mention
		// before this, so the pattern is anchored to the approval word and not
		// to the start of the raw comment.
		const got = readIntent("go #6580278184", { proposalWaiting: true })
		assert.equal(got.kind, INTENT.GO)
		assert.equal(got.proposalId, "6580278184")
	})

	test("a pasted comment link names a plan just as well", () => {
		const got = readIntent("go https://github.com/o/r/pull/1#issuecomment-6580278184", { proposalWaiting: true })
		assert.equal(got.kind, INTENT.GO)
		assert.equal(got.proposalId, "6580278184")
	})

	test("a bare go names nothing, so the newest plan still wins", () => {
		const got = readIntent("go", { proposalWaiting: true })
		assert.equal(got.kind, INTENT.GO)
		assert.equal(got.proposalId, undefined)
	})

	test("a pull request number is not a comment id", () => {
		// "go #25" is somebody pointing at a pull request, not at a plan.
		const got = readIntent("go #25", { proposalWaiting: true })
		assert.equal(got.kind, INTENT.GO)
		assert.equal(got.proposalId, undefined)
	})

	test("naming a plan that is not there finds nothing rather than the newest", () => {
		const comments = [proposal(1001, "generate"), proposal(1002, "fix")]
		assert.equal(findProposal(comments, SHA, now, US, { id: 9999 }), undefined)
	})

	test("a named plan still has to be ours", () => {
		const theirs = { ...proposal(1001, "fix"), user: { type: "User", login: "someone" } }
		assert.equal(findProposal([theirs], SHA, now, US, { id: 1001 }), undefined)
	})
})

describe("the record of a spent plan knows which job it was", () => {
	test("approving one job leaves another job's plan approvable", () => {
		// The bug, in one assertion. Both plans are on the same commit.
		const comments = [proposal(1001, "generate"), proposal(1002, "fix"), consumed(1003, "fix")]
		const got = findProposal(comments, SHA, now, US)
		assert.equal(got?.id, 1001, "the generate plan was never approved and must still be waiting")
	})

	test("the approved job's own plan is spent", () => {
		const comments = [proposal(1002, "fix"), consumed(1003, "fix")]
		assert.equal(findProposal(comments, SHA, now, US), undefined)
	})

	test("dropping one job leaves another alone", () => {
		const dropped = {
			id: 1003,
			user: { type: "Bot", login: US },
			created_at: fresh,
			body: proposalDroppedMarkerFor(SHA, "fix"),
		}
		const comments = [proposal(1001, "generate"), proposal(1002, "fix"), dropped]
		assert.equal(findProposal(comments, SHA, now, US)?.id, 1001)
	})

	test("a marker written before jobs were recorded still spends the whole commit", () => {
		// Back-compat: an old thread mid-upgrade. Treating it as spending
		// nothing would re-run work somebody already approved.
		const old = { id: 1003, user: { type: "Bot", login: US }, created_at: fresh, body: proposalConsumedMarkerFor(SHA) }
		const comments = [proposal(1001, "generate"), proposal(1002, "fix"), old]
		assert.equal(findProposal(comments, SHA, now, US), undefined)
	})

	test("a spent plan on another commit does not count", () => {
		const comments = [proposal(1001, "fix"), consumed(1003, "fix", "0000000000000000")]
		assert.equal(findProposal(comments, SHA, now, US)?.id, 1001)
	})

	test("proposalAlreadyUsed says which job, when asked about one", () => {
		const comments = [consumed(1003, "fix")]
		assert.equal(proposalAlreadyUsed(comments, SHA, US, "fix"), "approved")
		assert.equal(proposalAlreadyUsed(comments, SHA, US, "generate"), undefined)
	})

	test("the sweep only drops a plan whose own job is still waiting", () => {
		const stale = "2026-11-01T11:00:00Z"
		const comments = [proposal(1001, "generate", { at: stale }), consumed(1003, "fix")]
		assert.equal(proposalNeedsDropping(comments, SHA, now, US), true)
		const alsoDropped = [
			...comments,
			{ id: 1004, user: { type: "Bot", login: US }, created_at: fresh, body: proposalDroppedMarkerFor(SHA, "generate") },
		]
		assert.equal(proposalNeedsDropping(alsoDropped, SHA, now, US), false)
	})
})

describe("the result comment says which plan it carried out", () => {
	test("an approved run links the plan it ran", () => {
		const body = renderJobSummary({
			workflow: "fix",
			outcome: OUTCOMES.SUCCEEDED,
			summary: {},
			runUrl: "https://run",
			approvedPlan: { id: 1001, url: "https://github.com/o/r/pull/1#issuecomment-1001" },
		})
		assert.match(body, /Plan/)
		assert.match(body, /issuecomment-1001/)
	})

	test("a run nobody approved has no plan row", () => {
		const body = renderJobSummary({ workflow: "fix", outcome: OUTCOMES.SUCCEEDED, summary: {}, runUrl: "https://run" })
		assert.doesNotMatch(body, /\| Plan \|/)
	})
})

describe("naming a plan does not need the mention", () => {
	/**
	 * FOUND ON A LIVE RUN, 3 November. `readIntent` and `findProposal` both
	 * learned about `go `, and the gate in plan-run.mjs that decides
	 * whether an UNADDRESSED comment reaches us at all did not — it still
	 * only accepted a bare `go`. So `go ` was dropped as "no
	 * @test-companion mention" before the intent was ever read, and naming a
	 * plan only worked if you also addressed the comment.
	 *
	 * Still narrow. `go` followed by a plan reference and nothing else is
	 * unmistakably aimed at us; "Approved, but rename the login case" is still
	 * an ordinary review comment and still needs the mention (M3, ).
	 */
	const comment = (body) => ({
		action: "created",
		issue: { number: 7, pull_request: {} },
		comment: { body, user: { login: "an-sdet" } },
	})

	test("go #id is carried through unaddressed", () => {
		const out = planRun({ eventName: "issue_comment", payload: comment("go #6599834707"), repo: "acme/shop" })
		assert.equal(out.skip, undefined)
		assert.equal(out.approvalOnly, true)
	})

	test("so is a pasted comment link", () => {
		const body = "go https://github.com/acme/shop/pull/7#issuecomment-6599834707"
		const out = planRun({ eventName: "issue_comment", payload: comment(body), repo: "acme/shop" })
		assert.equal(out.skip, undefined)
		assert.equal(out.approvalOnly, true)
	})

	test("a bare go still is", () => {
		const out = planRun({ eventName: "issue_comment", payload: comment("go"), repo: "acme/shop" })
		assert.equal(out.approvalOnly, true)
	})

	test("but approval with edits still needs the mention", () => {
		const out = planRun({
			eventName: "issue_comment",
			payload: comment("Approved, but rename the login case"),
			repo: "acme/shop",
		})
		assert.equal(out.skip?.reason, "not-addressed-to-us")
	})

	test("and a number that is not a plan reference does not open the gate", () => {
		// "go #25" is somebody pointing at a pull request. It is a bare-ish go,
		// so it is carried through — but as a BARE one, with no plan named.
		const out = planRun({ eventName: "issue_comment", payload: comment("go and look at #25 too"), repo: "acme/shop" })
		assert.equal(out.skip?.reason, "not-addressed-to-us")
	})
})

describe("naming a plan is not editing it", () => {
	/**
	 *  (kritansh20, ). `hasApproverEdits("go ")`
	 * was true, because the bare-approval pattern allowed no plan reference.
	 * That is not just a wrong line in the report: renderApprovedPlan uses the
	 * same answer to append "# Changes the approver made … these win" to the
	 * plan the agent is handed. So the feature added by item 5 injected its own
	 * comment id into the plan as an authoritative instruction.
	 */
	test("go #id is a bare approval", () => {
		assert.equal(hasApproverEdits("go #6600030205"), false)
		assert.equal(hasApproverEdits("approved #6600030205"), false)
		assert.equal(hasApproverEdits("go https://github.com/o/r/pull/1#issuecomment-6600030205"), false)
	})

	test("so the plan the agent gets is just the plan", () => {
		const plan = renderApprovedPlan("do the thing", "go #6600030205")
		assert.doesNotMatch(plan, /Changes the approver made/)
		assert.doesNotMatch(plan, /6600030205/)
	})

	test("a real edit is still an edit, and still wins", () => {
		assert.equal(hasApproverEdits("go, and also cover the empty cart"), true)
		const plan = renderApprovedPlan("do the thing", "go, and also cover the empty cart")
		assert.match(plan, /Changes the approver made/)
		assert.match(plan, /empty cart/)
	})

	test("a bare go is still bare", () => {
		assert.equal(hasApproverEdits("go"), false)
		assert.equal(hasApproverEdits("Approved."), false)
	})
})

describe("a plan reference has to sit next to the approval", () => {
	/**
	 * . GO_TARGET matched a `#id` anywhere in the comment, so
	 * "@test-companion go — and pull the steps from <url>#issuecomment-…"
	 * became an approval of a plan that does not exist, and was refused.
	 */
	test("a link quoted later in the sentence is not a plan reference", () => {
		const got = readIntent(
			"@test-companion go — and pull the steps from https://github.com/o/r/pull/9#issuecomment-2345678901",
			{
				proposalWaiting: true,
			},
		)
		assert.equal(got.kind, INTENT.GO)
		assert.equal(got.proposalId, undefined)
	})

	test("one that does sit next to it still counts", () => {
		assert.equal(readIntent("go #6600030205", { proposalWaiting: true }).proposalId, "6600030205")
		assert.equal(
			readIntent("approved https://github.com/o/r/pull/1#issuecomment-6600030205", { proposalWaiting: true }).proposalId,
			"6600030205",
		)
	})
})
