/**
 * Should this request run, or wait for someone to approve it? — STM-5434 FR-43.
 *
 * The flagship interaction in the PRD: a developer asks, Test Companion says
 * what it plans to do, an SDET replies "go", and only then does anything get
 * written.
 *
 * The mechanism is deliberately boring. A held request is run in PREVIEW and
 * its report becomes the proposal. Preview has been enforced in the agent's
 * tool dispatch since Release 1, so FR-43's "nothing SHALL be written before
 * go" is a property of how the run executes rather than a promise made in a
 * prompt. The alternative — a separate "propose only" mode in the brain —
 * would be a second thing to keep honest.
 *
 * Pure, so every branch is testable without a runner.
 */
import { INTENT } from "./intent.mjs"

/** What to do with the request. */
export const GATE = Object.freeze({
	/** Run it. `preview` says whether for real. */
	RUN: "run",
	/** Run it in preview and post the report as a proposal, then end — FR-43. */
	PROPOSE: "propose",
	/** A "go" arrived with no proposal waiting. */
	NOTHING_TO_APPROVE: "nothing-to-approve",
	/** A "go" arrived on a proposal older than the FR-44 window. */
	EXPIRED: "expired",
})

const STRAIGHT_THROUGH = "straight-through"

/**
 * `approval` is the RESOLVED value from `tc workflow bindings --json`.
 *
 * Anything else — an unvalidated value, or a bindings read that failed and left
 * it undefined — holds for review. Fails closed, matching ResolvedApproval on
 * the Go side: the cost of a needless proposal is one comment, and the cost of
 * the other mistake is an unreviewed run that writes.
 */
export function decideGate({ intent, approval, proposal, actor } = {}) {
	if (intent?.kind === INTENT.GO) {
		if (!proposal) return { action: GATE.NOTHING_TO_APPROVE }
		if (proposal.expired) return { action: GATE.EXPIRED }
		// Approving is the whole point, so this is explicitly not a preview.
		//
		// selfApproved is reported, not refused. Asking and approving both need
		// write access, so this is not a privilege boundary — it is a
		// workflow-integrity signal. Refusing it outright would strand a solo
		// maintainer, who could then never approve anything.
		return {
			action: GATE.RUN,
			preview: false,
			approvedProposal: proposal.id,
			selfApproved: Boolean(proposal.requester) && proposal.requester === actor,
		}
	}

	// They already asked for the safe thing. Holding a preview for approval
	// would be asking permission to write nothing.
	if (intent?.preview) return { action: GATE.RUN, preview: true }

	if (approval === STRAIGHT_THROUGH) return { action: GATE.RUN, preview: false }

	// "review-before-run", and anything unrecognised, which fails closed here.
	return { action: GATE.PROPOSE, preview: true }
}

/** FR-44's thresholds, both marked ASSUMPTION in the PRD. */
const MANY_FILES = 20
const MANY_LINES = 1000

/**
 * Is this change too big to test in one go? — FR-44.
 *
 * An unreadable pull request is NOT large. Getting that backwards would tell
 * every reviewer their change is too big whenever the API call failed.
 *
 * NOT YET: FR-44 goes on to say the run should propose a FOCUSED set and list
 * what it left out. Choosing which part of a thirty-file change to test is the
 * agent's judgement, and there is no input for handing it that instruction
 * today, so this reports the size and lets the reviewer narrow the proposal
 * before approving it. Passing a context key nothing reads would look finished
 * and do nothing.
 */
export function describeChangeSize(pr) {
	const files = Number(pr?.changed_files ?? 0)
	const lines = Number(pr?.additions ?? 0) + Number(pr?.deletions ?? 0)
	return { files, lines, large: files > MANY_FILES || lines > MANY_LINES }
}
