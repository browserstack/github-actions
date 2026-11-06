/**
 * Should this request run, or wait for someone to approve it?
 *
 * A developer asks, Test Companion says what it plans to do, a reviewer
 * replies "go", and only then is anything written.
 *
 * The mechanism is deliberately boring: a held request runs in PREVIEW and
 * its report becomes the proposal. Preview is enforced in the agent's tool
 * dispatch, so "nothing is written before go" is a property of how the run
 * executes rather than a promise made in a prompt.
 *
 * Pure, so every branch is testable without a runner.
 */
import { INTENT } from "./intent.mjs"

/** What to do with the request. */
export const GATE = Object.freeze({
	/** Run it. `preview` says whether for real. */
	RUN: "run",
	/** Run it in preview and post the report as a proposal, then end. */
	PROPOSE: "propose",
	/** A "go" arrived with no proposal waiting. */
	NOTHING_TO_APPROVE: "nothing-to-approve",
	/** A "go" arrived on a proposal older than the window. */
	EXPIRED: "expired",
})

const STRAIGHT_THROUGH = "straight-through"

/**
 * `approval` is the RESOLVED value from `tc workflow bindings --json`.
 *
 * Anything else — unvalidated, or a bindings read that failed — holds for
 * review. Fails closed: a needless proposal costs one comment, the other
 * mistake is an unreviewed run that writes.
 */
export function decideGate({ intent, approval, proposal, actor, workflow } = {}) {
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

	// The same reasoning for a job that CANNOT write. `rca` and `verdict`
	// produce an explanation and nothing else, so there is nothing to approve
	// and the proposal would be empty.
	//
	// PREVIEW, not just unheld. Skipping the hold is only safe because the run
	// cannot write, and that has to be made true rather than assumed: these
	// jobs run with --yolo and a shell, and a binding set to `mode: live`
	// would otherwise hand an unapproved run write tools.
	if (ANSWER_JOBS.has(workflow)) return { action: GATE.RUN, preview: true }

	if (approval === STRAIGHT_THROUGH) return { action: GATE.RUN, preview: false }

	// "review-before-run", and anything unrecognised, which fails closed here.
	return { action: GATE.PROPOSE, preview: true }
}

/**
 * Jobs that produce an explanation and no artefact.
 *
 * Used by the gate above and by whether the Action shows the answer in the
 * comment. Mirrored on the CLI side, which decides whether to write the
 * answer to the result file at all.
 */
export const ANSWER_JOBS = new Set(["rca", "verdict"])

/** Where a change stops being reviewable in one go. Both are assumptions. */
const MANY_FILES = 20
const MANY_LINES = 1000

/**
 * Is this change too big to test in one go?
 *
 * An unreadable pull request is NOT large. Getting that backwards would tell
 * every reviewer their change is too big whenever the API call failed.
 *
 * Reports the size only. Choosing which part of a thirty-file change to test
 * is the agent's judgement, and there is no input for handing it that
 * instruction, so the reviewer narrows the proposal before approving it.
 */
export function describeChangeSize(pr) {
	const files = Number(pr?.changed_files ?? 0)
	const lines = Number(pr?.additions ?? 0) + Number(pr?.deletions ?? 0)
	return { files, lines, large: files > MANY_FILES || lines > MANY_LINES }
}
