import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { OUTCOMES } from "../src/outcome.mjs"
import {
	renderJobSummary,
	renderComment,
	chooseCommentAction,
	checkSha,
	COMMENT_MARKER,
	renderNotAuthorized,
	renderUnknownRequest,
	proposalMarkerFor,
	findProposal,
	renderProposal,
	proposalDroppedMarkerFor,
	proposalNeedsDropping,
	flattenPages,
	renderExtraChecks,
	accessibilityFailsCheck,
	renderApprovedPlan,
	hasApproverEdits,
	renderProposalBody,
	findSupersededProposal,
	checkRequestFor,
	inFlightCheckId,
} from "../src/report.mjs"

const base = {
	workflow: "generate",
	outcome: OUTCOMES.SUCCEEDED,
	summary: { workflow: "generate", event: "pr_merged", preview: "true", duration: "38s" },
	runUrl: "https://github.com/acme/shop/actions/runs/99",
}

describe("renderJobSummary — FR-27", () => {
	test("leads with what happened", () => {
		const md = renderJobSummary(base)
		assert.match(md, /Succeeded/)
		assert.match(md, /generate/)
	})

	// FR-8: a preview run must be marked as one wherever it reports, or a reader
	// sees a clean result and assumes the work landed.
	test("marks a preview run, and scopes the claim to Test Companion's own writes", () => {
		const md = renderJobSummary(base)
		assert.match(md, /Preview/i)
		assert.match(md, /write tools/i)
		// It must NOT claim nothing at all was written. Preview deliberately
		// allows `execute_command`, since that is how tests run, so a shell
		// command the agent chose can still edit a file or push. The old wording
		// promised a guarantee the gate does not give (review finding, #3030).
		assert.doesNotMatch(md, /\bnothing was written\b/i)
		assert.match(md, /[Ss]hell commands.*not covered/i)
	})

	test("does not claim preview on a live run", () => {
		const md = renderJobSummary({ ...base, summary: { ...base.summary, preview: "false" } })
		assert.doesNotMatch(md, /Preview —/i)
	})

	// Every run leaves a readable result, including the ones that went wrong —
	// a run with no report at all is exactly when the reader needs the page most.
	test("still renders when the CLI left no report", () => {
		const md = renderJobSummary({ ...base, outcome: OUTCOMES.COULD_NOT_RUN, summary: {} })
		assert.match(md, /Could not run/)
		assert.ok(md.length > 0)
	})

	test("links the run", () => {
		assert.match(renderJobSummary(base), /actions\/runs\/99/)
	})
})

describe("renderComment — FR-29", () => {
	// The marker is how the next run finds this comment instead of adding a
	// second one. It must be in every comment we ever write.
	test("always carries the marker that makes it findable", () => {
		assert.match(renderComment(base), new RegExp(COMMENT_MARKER))
	})

	test("is hidden from the reader", () => {
		const c = renderComment(base)
		assert.match(c, /<!--/, "the marker must be an HTML comment, not visible text")
	})
})

describe("chooseCommentAction — FR-29", () => {
	const ours = { id: 7, body: `hello ${COMMENT_MARKER}`, user: { type: "Bot" } }
	const theirs = { id: 8, body: "looks good", user: { type: "User" } }

	test("updates our existing comment rather than adding another", () => {
		assert.deepEqual(chooseCommentAction([theirs, ours]), { action: "update", id: 7 })
	})

	test("creates one when there is none yet", () => {
		assert.deepEqual(chooseCommentAction([theirs]), { action: "create" })
	})

	// Someone quoting our comment in their own reply must not capture the thread.
	test("ignores a human comment that merely quotes the marker", () => {
		const quoting = { id: 9, body: `> ${COMMENT_MARKER}\nwhy did this fail?`, user: { type: "User" } }
		assert.deepEqual(chooseCommentAction([quoting]), { action: "create" })
	})

	test("updates the oldest of ours if somehow there are two", () => {
		const second = { id: 11, body: `later ${COMMENT_MARKER}`, user: { type: "Bot" } }
		assert.deepEqual(chooseCommentAction([ours, second]), { action: "update", id: 7 })
	})

	test("an empty thread is not a crash", () => {
		assert.deepEqual(chooseCommentAction([]), { action: "create" })
		assert.deepEqual(chooseCommentAction(undefined), { action: "create" })
	})
})

describe("which commit the check lands on", () => {
	// On a pull_request event GITHUB_SHA is the MERGE commit, not the branch.
	// A check posted there is invisible on the pull request and cannot satisfy
	// branch protection — found on the first live run, where the check existed
	// but on a commit nobody looks at.
	test("prefers the head commit the event named over GITHUB_SHA", async () => {
		const { checkSha } = await import("../src/report.mjs")
		assert.equal(checkSha({ sha: "head123" }, {}, "merge999"), "head123")
	})

	test("falls back to the report, then to the run's own commit", async () => {
		const { checkSha } = await import("../src/report.mjs")
		assert.equal(checkSha({}, { sha: "fromreport" }, "merge999"), "fromreport")
		assert.equal(checkSha({}, {}, "merge999"), "merge999")
	})
})

describe("what the run cost and produced — FR-27", () => {
	// A report that says a run "Succeeded" and nothing else leaves the two
	// questions a reviewer actually has unanswered: what did it cost me, and
	// where did its work go.
	test("reports the cost in credits, the unit the ceiling is written in", () => {
		const out = renderJobSummary({ outcome: "Succeeded", summary: { credits: "13" } })
		assert.match(out, /13 credits/)
	})

	test("says nothing about cost when the run recorded none", () => {
		const out = renderJobSummary({ outcome: "Could not run", summary: {} })
		assert.ok(!/credits/i.test(out), out)
	})

	test("says how many cases it generated and how many landed", () => {
		const out = renderJobSummary({
			outcome: "Succeeded",
			summary: { cases_generated: "12", cases_saved: "3" },
		})
		assert.match(out, /12/)
		assert.match(out, /3/)
	})

	// "3 saved" with no destination sends the reader hunting through Test
	// Management for a folder nobody named.
	test("names where the cases were saved", () => {
		const out = renderJobSummary({
			outcome: "Succeeded",
			summary: { cases_generated: "3", cases_saved: "3", saved_to: "Regression / Weather" },
		})
		assert.match(out, /Regression \/ Weather/)
	})

	// The sharpest case: cases exist, nothing was written. Without saying so
	// plainly, "12 generated" reads as "12 saved".
	test("spells out that nothing was written when nothing landed", () => {
		const out = renderJobSummary({
			outcome: "Succeeded",
			summary: { cases_generated: "12", cases_saved: "0" },
		})
		assert.match(out, /not saved|nothing was (written|saved)/i)
	})

	test("points at the downloadable result when the run produced one", () => {
		const out = renderJobSummary({
			outcome: "Succeeded",
			summary: { cases_generated: "12", cases_saved: "0" },
			resultArtifact: "test-companion-result",
		})
		assert.match(out, /test-companion-result/)
	})

	// An rca or fix run generates no cases at all. A row reading "0 generated"
	// on it looks like something went wrong.
	test("leaves the whole section out for a run that generates nothing", () => {
		const out = renderJobSummary({ outcome: "Succeeded", summary: { duration: "2m" } })
		assert.ok(!/generated/i.test(out), out)
	})
})

describe("naming what failed — FR-28", () => {
	// "Tests failed" with no names makes the reviewer open the run and read the
	// logs, which is the thing a pull request report exists to avoid.
	test("lists the failing tests by name", () => {
		const out = renderJobSummary({
			outcome: "Tests failed",
			summary: {},
			failedTests: [{ name: "Checkout > pays", file: "tests/checkout.spec.ts", line: 18 }, { name: "should log in" }],
		})
		assert.match(out, /Checkout > pays/)
		assert.match(out, /should log in/)
	})

	test("gives the location when there is one", () => {
		const out = renderJobSummary({
			outcome: "Tests failed",
			summary: {},
			failedTests: [{ name: "Checkout > pays", file: "tests/checkout.spec.ts", line: 18 }],
		})
		assert.match(out, /tests\/checkout\.spec\.ts:18/)
	})

	// A hundred names turn the check into a wall. Show the first few and say
	// how many more there are.
	test("caps the list and says how many it left out", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ name: `test number ${i}` }))
		const out = renderJobSummary({ outcome: "Tests failed", summary: {}, failedTests: many })
		assert.ok(!out.includes("test number 39"), "the 40th should not be listed")
		assert.match(out, /\d+ more/)
	})

	test("says nothing when nothing failed", () => {
		const out = renderJobSummary({ outcome: "Succeeded", summary: {}, failedTests: [] })
		assert.ok(!/failed test/i.test(out), out)
	})
})

describe("replying when we will not run — FR-33, FR-34", () => {
	/**
	 * Both of these used to go only to the job summary. The person who commented
	 * never opens the run's logs, so from where they sat Test Companion simply
	 * ignored them.
	 */
	test("someone without write access is told so, and who can ask — FR-33", () => {
		const body = renderNotAuthorized("octocat")
		assert.match(body, /@octocat/)
		assert.match(body, /write access/i)
	})

	test("a request we cannot place gets the list of what we can do — FR-34", () => {
		const body = renderUnknownRequest()
		for (const phrase of ["test this PR", "explain this failure", "fix the failing tests", "stop"]) {
			assert.ok(body.includes(phrase), `the list should offer "${phrase}"`)
		}
	})

	/**
	 * A refusal is not a run report. If it carried the marker, chooseCommentAction
	 * would treat it as the one tracked comment: the oldest wins, so the first
	 * refusal on a pull request would become the place every later run wrote its
	 * results — or sit there forever while results went elsewhere.
	 */
	test("neither reply carries the run marker", () => {
		assert.ok(!renderNotAuthorized("octocat").includes(COMMENT_MARKER))
		assert.ok(!renderUnknownRequest().includes(COMMENT_MARKER))
	})

	test("a refusal is not mistaken for the tracked comment", () => {
		const refusal = { id: 1, user: { type: "Bot" }, body: renderNotAuthorized("octocat") }
		assert.deepEqual(chooseCommentAction([refusal]), { action: "create" })
	})
})

describe("the waiting proposal — FR-43, FR-44", () => {
	const SHA = "abc123"
	const marker = proposalMarkerFor(SHA)
	const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString()
	const proposal = (over = {}) => ({
		id: 10,
		user: { type: "Bot" },
		body: `here is what I plan to do\n\n${marker}`,
		created_at: hoursAgo(1),
		...over,
	})

	test("a proposal is found for the commit it was made on", () => {
		assert.equal(findProposal([proposal()], SHA)?.id, 10)
	})

	/**
	 * FR-44: "New commits while waiting SHALL replace the proposal." Keying the
	 * marker to the commit is what makes that true without any sweeping — a
	 * proposal simply stops being found once the branch moves, so "go" on a
	 * stale proposal cannot approve work nobody reviewed.
	 */
	test("a proposal for an older commit is not found", () => {
		assert.equal(findProposal([proposal()], "deadbee"), undefined)
	})

	// Same reasoning as chooseCommentAction: a person quoting our proposal in
	// their reply would otherwise be able to approve their own request.
	test("only a comment WE wrote counts", () => {
		const quoted = proposal({ user: { type: "User" } })
		assert.equal(findProposal([quoted], SHA), undefined)
	})

	test("the newest proposal wins when there are several", () => {
		assert.equal(findProposal([proposal({ id: 10 }), proposal({ id: 12 })], SHA)?.id, 12)
	})

	test("a proposal inside the window has not expired — FR-44", () => {
		assert.equal(findProposal([proposal({ created_at: hoursAgo(23) })], SHA)?.expired, false)
	})

	test("after 24 hours it has — FR-44", () => {
		assert.equal(findProposal([proposal({ created_at: hoursAgo(25) })], SHA)?.expired, true)
	})

	test("no proposals at all is undefined, not a throw", () => {
		assert.equal(findProposal([], SHA), undefined)
		assert.equal(findProposal(undefined, SHA), undefined)
	})

	test("the proposal says how to approve it, and carries its marker", () => {
		const body = renderProposal("## what I plan to do", SHA)
		assert.ok(body.includes(marker), "must carry the sha-keyed marker")
		assert.match(body, /\bgo\b/i)
	})

	// It must not be mistaken for the tracked run comment, for the same reason
	// a refusal must not be.
	test("a proposal is not the tracked run comment", () => {
		const p = { id: 1, user: { type: "Bot" }, body: renderProposal("x", SHA) }
		assert.deepEqual(chooseCommentAction([p]), { action: "create" })
	})
})

describe("dropping a proposal nobody answered — FR-44", () => {
	const SHA = "abc123"
	const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString()
	const proposal = (h) => ({
		id: 10,
		user: { type: "Bot" },
		body: `plan\n\n${proposalMarkerFor(SHA)}`,
		created_at: hoursAgo(h),
	})
	const dropNotice = { id: 11, user: { type: "Bot" }, body: proposalDroppedMarkerFor(SHA) }

	/**
	 * Without this sweep, a proposal nobody replies to leaves the check on
	 * "in progress" forever — and anyone who made it a required check is blocked
	 * by a check that never resolves. That is the exact failure Release 2 avoided
	 * by posting the tick at the end, so FR-44's in-progress check may only exist
	 * if something is guaranteed to end it.
	 */
	test("an expired proposal needs dropping", () => {
		assert.equal(proposalNeedsDropping([proposal(25)], SHA), true)
	})

	test("one still inside the window is left alone", () => {
		assert.equal(proposalNeedsDropping([proposal(2)], SHA), false)
	})

	// The sweep runs nightly. Without this it would post a fresh check and a
	// fresh comment on the same dead proposal every single night.
	test("one already dropped is not dropped again", () => {
		assert.equal(proposalNeedsDropping([proposal(25), dropNotice], SHA), false)
	})

	test("the drop notice is not mistaken for a proposal", () => {
		assert.equal(findProposal([dropNotice], SHA), undefined)
	})

	test("no proposal at all needs nothing", () => {
		assert.equal(proposalNeedsDropping([], SHA), false)
	})
})

describe("reading a paginated gh response — FR-29", () => {
	/**
	 * `gh api --paginate --slurp` returns an ARRAY OF PAGES, not a flat array of
	 * items — and it wraps even when there is only one page. Verified against
	 * gh 2.91.0: twelve pages at per_page=2, and still `[[...]]` at per_page=100.
	 *
	 * This matters because chooseCommentAction filters on `c.user.type`. Handed
	 * an array of arrays it matches nothing, returns "create" every time, and
	 * every run posts a NEW comment — which is exactly the single-comment
	 * guarantee FR-29 asks for, broken in the fix that was meant to protect it.
	 */
	test("pages are flattened into items", () => {
		const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }]]
		assert.deepEqual(flattenPages(pages), [{ id: 1 }, { id: 2 }, { id: 3 }])
	})

	test("one page is still wrapped, and still flattens", () => {
		assert.deepEqual(flattenPages([[{ id: 1 }]]), [{ id: 1 }])
	})

	// Defensive: objects are not arrays, so flat() leaves an already-flat list
	// alone. That keeps this correct if gh ever changes its mind.
	test("an already-flat list is unchanged", () => {
		assert.deepEqual(flattenPages([{ id: 1 }]), [{ id: 1 }])
	})

	test("nothing is an empty list, not a throw", () => {
		assert.deepEqual(flattenPages(undefined), [])
		assert.deepEqual(flattenPages(null), [])
	})

	test("our comment is found once the pages are flattened", () => {
		const pages = [[{ id: 5, user: { type: "Bot" }, body: `x ${COMMENT_MARKER}` }]]
		assert.deepEqual(chooseCommentAction(flattenPages(pages)), { action: "update", id: 5 })
		// and is NOT found without flattening, which is the bug
		assert.deepEqual(chooseCommentAction(pages), { action: "create" })
	})
})

describe("who asked for a proposal — FR-43", () => {
	const SHA = "abc123"
	const bot = (body, over = {}) => ({ id: 10, user: { type: "Bot" }, body, created_at: new Date().toISOString(), ...over })

	test("the marker records who asked", () => {
		assert.match(proposalMarkerFor(SHA, "octocat"), /by=octocat/)
	})

	test("findProposal reports it, so self-approval can be seen", () => {
		const p = findProposal([bot(`plan\n\n${proposalMarkerFor(SHA, "octocat")}`)], SHA)
		assert.equal(p?.requester, "octocat")
	})

	// Proposals written before the requester was recorded must keep working
	// rather than becoming unapprovable.
	test("a marker with no requester is still found", () => {
		const p = findProposal([bot(`plan\n\n${proposalMarkerFor(SHA)}`)], SHA)
		assert.equal(p?.id, 10)
		assert.equal(p?.requester, undefined)
	})

	test("a proposal for another commit is still not found, requester or not", () => {
		assert.equal(findProposal([bot(`x\n\n${proposalMarkerFor(SHA, "octocat")}`)], "deadbee"), undefined)
	})
})

describe("self-approval is visible in the report — FR-43", () => {
	test("the note appears where a reviewer reads the result", () => {
		const body = renderJobSummary({
			outcome: OUTCOMES.SUCCEEDED,
			summary: {},
			approvalNote: " Approved by @octocat, who also asked for it.",
		})
		assert.match(body, /also asked for it/)
	})

	test("an ordinary run says nothing about approval", () => {
		const body = renderJobSummary({ outcome: OUTCOMES.SUCCEEDED, summary: {} })
		assert.ok(!/approved by/i.test(body))
	})
})

describe("the refusal names the team when one is set — FR-33", () => {
	test("without a team, it names write access", () => {
		assert.match(renderNotAuthorized("octocat"), /write access/i)
	})

	test("with a team, it names the team, because write access alone is no longer enough", () => {
		const body = renderNotAuthorized("octocat", "qa-leads")
		assert.match(body, /@octocat/)
		assert.match(body, /qa-leads/)
	})
})

describe("accessibility and visual lines — FR-45", () => {
	test("silent when the settings did not ask", () => {
		assert.deepEqual(renderExtraChecks({ accessibility_new: "3" }, {}), [])
	})

	test("the accessibility line reports what this change introduced", () => {
		const lines = renderExtraChecks({ accessibility_new: "3", accessibility_total: "11" }, { wcag: "AA" })
		assert.equal(lines.length, 1)
		assert.match(lines[0], /WCAG AA/)
		assert.match(lines[0], /3/)
	})

	// FR-45: "N changes awaiting review" with a Percy link.
	test("the visual line reports what is waiting, with its link", () => {
		const lines = renderExtraChecks({ visual_changes: "4", visual_url: "https://percy.io/x" }, { visual: true })
		assert.match(lines[0], /4 changes awaiting review/)
		assert.match(lines[0], /https:\/\/percy\.io\/x/)
	})

	test("asked for but not reported says so rather than claiming a pass", () => {
		const lines = renderExtraChecks({}, { wcag: "AA", visual: true })
		assert.equal(lines.length, 2)
		for (const l of lines) assert.match(l, /not reported|no result/i)
	})
})

describe("when accessibility may fail the check — FR-45", () => {
	// "SHALL fail the check only when the file says so, and by default only
	// violations this change introduced count."
	test("never by default, however many violations there are", () => {
		assert.equal(accessibilityFailsCheck({ accessibility_new: "9" }, { wcag: "AA" }), false)
	})

	test("only when the file asks, and only for what this change introduced", () => {
		assert.equal(accessibilityFailsCheck({ accessibility_new: "2" }, { wcag: "AA", failOnNew: true }), true)
		assert.equal(
			accessibilityFailsCheck({ accessibility_new: "0", accessibility_total: "40" }, { wcag: "AA", failOnNew: true }),
			false,
		)
	})

	test("not configured at all means it cannot fail", () => {
		assert.equal(accessibilityFailsCheck({ accessibility_new: "5" }, {}), false)
	})

	// A run that did not report cannot be said to have failed.
	test("a missing count is not a failure", () => {
		assert.equal(accessibilityFailsCheck({}, { wcag: "AA", failOnNew: true }), false)
	})
})

describe("the report carries the extra lines and warnings", () => {
	test("accessibility and visual lines appear in the summary", () => {
		const body = renderJobSummary({
			outcome: OUTCOMES.SUCCEEDED,
			summary: {},
			extraChecks: ["**Visual:** 4 changes awaiting review."],
		})
		assert.match(body, /4 changes awaiting review/)
	})

	test("a warning about where tests could not be written is shown", () => {
		const body = renderJobSummary({
			outcome: OUTCOMES.SUCCEEDED,
			summary: {},
			warnings: ["Test code is configured to go to `acme/shop-tests`, but this run cannot write there"],
		})
		assert.match(body, /acme\/shop-tests/)
	})

	test("an ordinary run shows neither", () => {
		const body = renderJobSummary({ outcome: OUTCOMES.SUCCEEDED, summary: {} })
		assert.ok(!/awaiting review/.test(body))
	})
})

describe("the approved plan handed to the run — FR-43", () => {
	const SHA = "abc123"

	test("findProposal returns the body, because the run has to read it", () => {
		const body = `## what I plan to do\n- case one\n\n${proposalMarkerFor(SHA, "octocat")}`
		const found = findProposal([{ id: 1, user: { type: "Bot" }, body, created_at: new Date().toISOString() }], SHA)
		assert.ok(found.body.includes("case one"))
	})

	test("the plan is the proposal, plus whatever the approver changed", () => {
		const plan = renderApprovedPlan("- case one\n- case two", "go, but drop case two")
		assert.match(plan, /case one/)
		assert.match(plan, /drop case two/)
	})

	/**
	 * FR-43 allows "go" with or without edits. A bare "go" must not leave the
	 * run looking for instructions that were never given.
	 */
	test("a bare approval carries no edits", () => {
		const plan = renderApprovedPlan("- case one", "go")
		assert.match(plan, /case one/)
		assert.ok(!/go/i.test(plan.split("case one")[1] ?? ""), "a bare go should not be presented as an edit")
	})

	// The marker is bookkeeping, not part of the plan, and leaving it in invites
	// the run to treat it as an instruction.
	test("the proposal's own marker is stripped out", () => {
		const plan = renderApprovedPlan(`- case one\n\n${proposalMarkerFor(SHA, "octocat")}`, "go")
		assert.ok(!plan.includes("test-companion-proposal"))
	})
})

describe("telling an edited approval from a bare one — FR-43", () => {
	test("a bare go carries no edits", () => {
		for (const bare of ["go", "GO", "go.", "approved", "approve!"]) {
			assert.equal(hasApproverEdits(bare), false, `"${bare}" is a bare approval`)
		}
	})

	test("anything more is an edit", () => {
		assert.equal(hasApproverEdits("go, but drop case two"), true)
		assert.equal(hasApproverEdits("approved — only the checkout cases"), true)
	})

	test("nothing at all is not an edit", () => {
		assert.equal(hasApproverEdits(""), false)
		assert.equal(hasApproverEdits(undefined), false)
	})
})

describe("the proposal carries the plan — FR-38, FR-43", () => {
	/**
	 * The first live run posted a proposal containing only a report header. The
	 * agent had designed nine test cases and verified them; none of it reached
	 * the comment, because renderProposal was only ever handed the job summary.
	 *
	 * A proposal with no plan in it cannot be reviewed, which makes approving it
	 * meaningless.
	 */
	test("the plan is included when the run produced one", () => {
		const body = renderProposalBody({ summary: "## Test Companion", plan: "- case one\n- case two" })
		assert.match(body, /case one/)
		assert.match(body, /Test Companion/)
	})

	// This used to assert "did not produce a plan" whenever the plan was empty.
	// That is right only when the run produced NOTHING. Only `test-pr` writes a
	// separate plan file; for rca, fix and verdict the proposal run is a
	// preview run whose report IS the thing being approved, and telling that
	// reader to "re-run once that is fixed" sent them to fix a run that worked.
	test("with a report and no plan file, the report is what is being approved", () => {
		const body = renderProposalBody({ summary: "## Test Companion", plan: "" })
		assert.doesNotMatch(body, /did not produce a plan/i)
		assert.match(body, /report above/i)
	})

	test("with neither, it still says there is nothing to approve", () => {
		const body = renderProposalBody({ summary: "", plan: "" })
		assert.match(body, /did not produce a plan/i)
	})

	test("a large change is called out above the plan", () => {
		const body = renderProposalBody({ summary: "s", plan: "p", sizeNote: "**This is a large change**" })
		assert.ok(body.indexOf("large change") < body.indexOf("p"), "the warning belongs before the list")
	})
})

describe("renderJobSummary — the saved work (FR-43)", () => {
	test("shows what was committed to the branch", () => {
		const out = renderJobSummary({
			outcome: "Succeeded",
			workNote: "**Saved to `feat/x`** as `abc1234` — 1 file:\n\n- `tests/a.spec.js`",
		})
		assert.match(out, /Saved to `feat\/x`/)
		assert.match(out, /tests\/a\.spec\.js/)
	})

	test("is silent when the run saved nothing", () => {
		assert.doesNotMatch(renderJobSummary({ outcome: "Succeeded" }), /Saved to/)
	})
})

describe("findSupersededProposal — telling a stale plan from silence (FR-44)", () => {
	/**
	 * Defect found live on 2026-10-29. Someone replied "go" after the branch
	 * had moved on, and was told:
	 *
	 *   "No @test-companion mention, so nothing was asked of Test Companion."
	 *
	 * Wrong twice. They DID give a valid approval word, and the real reason is
	 * that their plan was for an earlier commit. The guard that drops
	 * unaddressed chatter fired before anything noticed there was a superseded
	 * proposal sitting right there.
	 *
	 * The safety behaviour was already correct — a stale plan is never run.
	 * This is only about saying why.
	 */
	const proposal = (sha) => ({
		user: { type: "Bot" },
		body: `a plan\n\n<!-- test-companion-proposal sha=${sha} by=someone -->`,
	})

	test("a proposal for an earlier commit is found, and its sha reported", () => {
		const found = findSupersededProposal([proposal("aaaaaaa1")], "bbbbbbb2")
		assert.equal(found?.sha, "aaaaaaa1")
	})

	test("a proposal for THIS commit is not superseded — it is live", () => {
		assert.equal(findSupersededProposal([proposal("aaaaaaa1")], "aaaaaaa1"), undefined)
	})

	test("no proposal at all means nobody was talking to us", () => {
		assert.equal(findSupersededProposal([], "aaaaaaa1"), undefined)
		assert.equal(findSupersededProposal(undefined, "aaaaaaa1"), undefined)
	})

	test("the newest superseded proposal wins, not the first", () => {
		const found = findSupersededProposal(
			[
				{ ...proposal("aaa11111"), id: 1 },
				{ ...proposal("bbb22222"), id: 2 },
			],
			"ccc33333",
		)
		assert.equal(found?.sha, "bbb22222")
	})

	test("a person quoting our marker cannot fake one", () => {
		const human = { user: { type: "User" }, body: "<!-- test-companion-proposal sha=aaaaaaa1 -->" }
		assert.equal(findSupersededProposal([human], "bbbbbbb2"), undefined)
	})
})

describe("the proposal marker carries the JOB, not just the commit (FR-43)", () => {
	/**
	 * Reported in review of PR #3101. The marker recorded the commit and the
	 * requester and nothing else. On the GO path `intent.workflow` is
	 * undefined, so `plan.workflow` was never set and the CLI resolved the
	 * binding itself from `--event pr_comment` — MatchEvent(...)[0], whichever
	 * is first in the file.
	 *
	 * So on a repository with two pr_comment bindings: ask for `fix`, read a
	 * proposal for `fix`, reply `go`, and something else runs live with
	 * --yolo. FR-43 is "what you saw is what runs"; nothing carried the job
	 * across.
	 */
	test("the marker records the workflow", () => {
		assert.match(proposalMarkerFor("abc1234", "someone", "fix"), /workflow=fix/)
	})

	test("findProposal hands the workflow back, so the run can be pinned to it", () => {
		const comments = [
			{
				user: { type: "Bot" },
				body: `a plan\n\n${proposalMarkerFor("abc1234", "someone", "fix")}`,
			},
		]
		assert.equal(findProposal(comments, "abc1234")?.workflow, "fix")
	})

	/** Proposals written before the marker carried a job stay approvable. */
	test("a marker with no workflow still matches, and reports none", () => {
		const old = [{ user: { type: "Bot" }, body: "plan\n\n<!-- test-companion-proposal sha=abc1234 by=someone -->" }]
		const found = findProposal(old, "abc1234")
		assert.ok(found, "an older marker must still be found")
		assert.equal(found.workflow, undefined)
		assert.equal(found.requester, "someone")
	})

	test("the requester still survives alongside the workflow", () => {
		const comments = [{ user: { type: "Bot" }, body: proposalMarkerFor("abc1234", "someone", "test-pr") }]
		const found = findProposal(comments, "abc1234")
		assert.equal(found.requester, "someone")
		assert.equal(found.workflow, "test-pr")
	})
})

describe("checkRequestFor — one check per commit, not three (FR-48)", () => {
	test("the first check on a commit is created", () => {
		assert.deepEqual(checkRequestFor("abc", new Map()), { method: "POST", path: "check-runs" })
	})

	test("the second updates the first instead of adding another", () => {
		const made = new Map([["abc", 99]])
		assert.deepEqual(checkRequestFor("abc", made), { method: "PATCH", path: "check-runs/99" })
	})

	/** A run can check the head early and the reported commit later. */
	test("a different commit gets its own check", () => {
		const made = new Map([["abc", 99]])
		assert.deepEqual(checkRequestFor("def", made), { method: "POST", path: "check-runs" })
	})

	test("no memo at all still works", () => {
		assert.deepEqual(checkRequestFor("abc", undefined), { method: "POST", path: "check-runs" })
	})
})

describe("the two marker readers must not drift apart", () => {
	/**
	 * They already had. findProposal learned about `workflow=`;
	 * findSupersededProposal, 200 lines away, did not — and its pattern
	 * demanded ` -->` right after the optional `by=`, so it matched NO marker
	 * this branch writes.
	 *
	 * The consequence was the exact failure commit 0c2125b68f fixed: reply
	 * `go` after the branch moves, the superseded lookup finds nothing, and
	 * you are told "No @test-companion mention" again.
	 *
	 * The old tests missed it because the superseded block hand-wrote its
	 * fixture while the new marker tests only ever fed proposalMarkerFor()
	 * output to findProposal. Nothing crossed the two. These do.
	 */
	const bot = (body, id = 1) => ({ user: { type: "Bot" }, id, body: `a plan\n\n${body}` })

	test("a marker written by proposalMarkerFor is found by BOTH readers", () => {
		const marker = proposalMarkerFor("def5678", "alice", "test-pr")
		assert.equal(findProposal([bot(marker)], "def5678")?.workflow, "test-pr")
		assert.equal(findSupersededProposal([bot(marker)], "aaa1111")?.sha, "def5678")
	})

	test("and the superseded reader still reports who asked", () => {
		const marker = proposalMarkerFor("def5678", "alice", "fix")
		assert.equal(findSupersededProposal([bot(marker)], "aaa1111")?.requester, "alice")
	})

	test("every shape proposalMarkerFor can emit is readable by both", () => {
		for (const args of [
			["def5678", "alice", "fix"],
			["def5678", "alice", undefined],
			["def5678", undefined, "fix"],
			["def5678", undefined, undefined],
		]) {
			const marker = proposalMarkerFor(...args)
			assert.ok(findProposal([bot(marker)], "def5678"), `findProposal missed ${marker}`)
			assert.ok(findSupersededProposal([bot(marker)], "aaa1111"), `findSupersededProposal missed ${marker}`)
		}
	})
})

describe("inFlightCheckId — the sweep must finish what another run started", () => {
	test("finds our in-progress check", () => {
		assert.equal(inFlightCheckId([{ name: "Test Companion", status: "in_progress", id: 7 }]), 7)
	})

	test("a completed check is already answered", () => {
		assert.equal(inFlightCheckId([{ name: "Test Companion", status: "completed", id: 7 }]), undefined)
	})

	test("another tool's check is none of our business", () => {
		assert.equal(inFlightCheckId([{ name: "CI / build", status: "in_progress", id: 7 }]), undefined)
	})

	test("the newest wins, so a stale one cannot", () => {
		assert.equal(
			inFlightCheckId([
				{ name: "Test Companion", status: "in_progress", id: 3 },
				{ name: "Test Companion", status: "queued", id: 9 },
			]),
			9,
		)
	})

	test("nothing in, nothing out", () => {
		assert.equal(inFlightCheckId([]), undefined)
		assert.equal(inFlightCheckId(undefined), undefined)
	})
})

describe("a proposal for a job that writes no plan file", () => {
	/**
	 * Only `test-pr` has --propose-only and --plan-file, so only it produces a
	 * separate plan. For `rca`, `fix` and `verdict` the proposal run is a
	 * PREVIEW run — it does the work and writes nothing — and its report is
	 * what the reviewer approves.
	 *
	 * The body said "This run did not produce a plan — there is nothing here
	 * to approve", which is wrong for those jobs and tells the reader to
	 * re-run something that worked.
	 */
	test("says the report IS the plan, rather than that there is nothing to approve", () => {
		const out = renderProposalBody({ summary: "## Test Companion — Succeeded\n\nit went fine", plan: "" })
		assert.doesNotMatch(out, /nothing here to approve/)
		assert.match(out, /above/i)
	})

	test("a real plan still wins", () => {
		const out = renderProposalBody({ summary: "sum", plan: "1. write a test for the thing" })
		assert.match(out, /write a test for the thing/)
		assert.doesNotMatch(out, /nothing here to approve/)
	})

	test("a run that produced neither still says so", () => {
		const out = renderProposalBody({ summary: "", plan: "" })
		assert.match(out, /nothing here to approve/)
	})
})
