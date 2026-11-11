/**
 * Should this request run now, or be proposed and wait for "go"? A held
 * request runs in preview, which the agent's tool dispatch enforces.
 */
import { INTENT } from "./intent.mjs"

export const GATE = Object.freeze({
	RUN: "run",
	PROPOSE: "propose",
	NOTHING_TO_APPROVE: "nothing-to-approve",
	EXPIRED: "expired",
})

const STRAIGHT_THROUGH = "straight-through"

/**
 * `approval` is the resolved value from `tc workflow bindings --json`.
 * Anything unrecognised holds for review.
 */
export function decideGate({ intent, approval, proposal, actor, workflow } = {}) {
	if (intent?.kind === INTENT.GO) {
		if (!proposal) return { action: GATE.NOTHING_TO_APPROVE }
		if (proposal.expired) return { action: GATE.EXPIRED }
		// Self-approval is reported, not refused: both need write access anyway,
		// and refusing it would strand a solo maintainer.
		return {
			action: GATE.RUN,
			preview: false,
			approvedProposal: proposal.id,
			selfApproved: Boolean(proposal.requester) && proposal.requester === actor,
		}
	}

	if (intent?.preview) return { action: GATE.RUN, preview: true }

	// Answer-only jobs skip the hold, so force preview: a `mode: live` binding
	// would otherwise give an unapproved run write tools.
	if (ANSWER_JOBS.has(workflow)) return { action: GATE.RUN, preview: true }

	if (approval === STRAIGHT_THROUGH) return { action: GATE.RUN, preview: false }

	return { action: GATE.PROPOSE, preview: true }
}

/** Jobs that produce an explanation and no artefact. Mirrored in the CLI. */
export const ANSWER_JOBS = new Set(["rca", "verdict"])

// Rough thresholds for a change too big to review in one go.
const MANY_FILES = 20
const MANY_LINES = 1000

/** An unreadable pull request counts as not large. */
export function describeChangeSize(pr) {
	const files = Number(pr?.changed_files ?? 0)
	const lines = Number(pr?.additions ?? 0) + Number(pr?.deletions ?? 0)
	return { files, lines, large: files > MANY_FILES || lines > MANY_LINES }
}
