/**
 * What happened, in the five words the PRD specifies — STM-3663 FR-30, FR-48, FR-9.
 *
 * The CLI already distinguishes these cases, but across two channels: an exit
 * code (a stable contract — scripts branch on it) and a report file. Neither is
 * sufficient alone. Exit 4 covers a crash, a time ceiling AND a version-pin
 * mismatch, so only the report tells a ceiling from a crash; and a report can be
 * absent entirely if the process was killed.
 *
 * Three separate questions come out of that, and conflating them was the bug in
 * the first place:
 *   - what happened            → resolveOutcome  (the five labels)
 *   - what the check says      → checkConclusion (FR-48, never neutral)
 *   - whether the step is red  → stepShouldFail  (FR-9, the repo's own choice)
 *
 * The check always reports truthfully. The build effect only governs the step.
 */

/** The five outcomes, spelled exactly as FR-30 requires. */
export const OUTCOMES = Object.freeze({
	SUCCEEDED: "Succeeded",
	TESTS_FAILED: "Tests failed",
	RUN_BROKE: "Run broke",
	STOPPED_AT_LIMIT: "Stopped at limit",
	COULD_NOT_RUN: "Could not run",
	// Not one of FR-30's five. Those describe a run that HAPPENED; this says
	// none did, which the Action already reports for a draft PR, a fork, an
	// unaddressed comment and a repository with no pipeline file. An event
	// nothing is bound to belongs with those, not with the five.
	SKIPPED: "Skipped",
})

/**
 * Parse the CLI's report: one `key: value` per line.
 *
 * Splits on the FIRST colon only — a value is routinely a URL, and splitting on
 * every colon would truncate every build link. Unknown keys are kept rather than
 * dropped, so a newer CLI adding a field does not need a change here.
 */
export function parseSummary(text) {
	const out = {}
	if (!text) return out
	for (const line of String(text).split("\n")) {
		const at = line.indexOf(":")
		if (at === -1) continue
		const key = line.slice(0, at).trim()
		if (key) out[key] = line.slice(at + 1).trim()
	}
	return out
}

/**
 * Which of the five happened.
 *
 * `summary` is the parsed report, possibly empty — an absent report is a real
 * case, not an impossible one: the CLI only writes it when --summary-file was
 * passed, and never when the process was killed outright.
 */
export function resolveOutcome(exitCode, summary = {}) {
	// The report wins over a success exit code. This is not hypothetical: a run
	// with an expired BrowserStack session was observed exiting 0 with status
	// "completed" having done nothing at all, which any CI step checking only the
	// exit code would have read as green.
	// Nothing was bound to this event, so nothing ran. Checked before the
	// report-wins rule below, which would otherwise read "not succeeded" as a
	// breakage and put a red check on a commit that was never meant to run
	// anything (review finding, PR #3030).
	if (summary.outcome === "skipped") {
		return OUTCOMES.SKIPPED
	}
	if (exitCode === 0 && summary.outcome && summary.outcome !== "succeeded") {
		return summary.outcome === "failed" ? OUTCOMES.TESTS_FAILED : OUTCOMES.RUN_BROKE
	}

	switch (exitCode) {
		case 0:
			return OUTCOMES.SUCCEEDED
		// ExitTestFailed: the agent finished cleanly, the tests did not pass.
		case 5:
			return OUTCOMES.TESTS_FAILED
		// ExitTaskFailed covers three causes; only the report separates them.
		case 4:
			return summary.error_type === "ceiling_exceeded" ? OUTCOMES.STOPPED_AT_LIMIT : OUTCOMES.RUN_BROKE
		// ExitUsage: a bad pipeline file or bad flags, so nothing ran.
		case 2:
			return OUTCOMES.COULD_NOT_RUN
		// ExitAuth: not signed in.
		case 3:
			return OUTCOMES.COULD_NOT_RUN
		// ExitTaskBlocked: the turn finished but the task could not be performed —
		// plan, entitlement, or a refusal.
		case 7:
			return OUTCOMES.COULD_NOT_RUN
		// ExitUnansweredQuestion: headless promised to answer every ask and did
		// not, so the run is broken rather than merely unfinished.
		case 6:
			return OUTCOMES.RUN_BROKE
		default:
			// Including exit 1. An unrecognised code is never reported as success.
			return OUTCOMES.RUN_BROKE
	}
}

/**
 * What the "Test Companion" check says — FR-48.
 *
 * Never `neutral`: branch protection treats a neutral check as a pass, so a
 * neutral conclusion would let a run that could not finish satisfy a required
 * check. That is the one thing this must not do.
 */
export function checkConclusion(outcome) {
	switch (outcome) {
		case OUTCOMES.SUCCEEDED:
			return "success"
		case OUTCOMES.TESTS_FAILED:
			return "failure"
		case OUTCOMES.SKIPPED:
			// Distinct from "could not finish", which the default below covers:
			// nothing was bound to this event, so there was nothing to run and
			// nothing to report. Defensive — main.mjs takes the skip path and
			// posts no check at all — but if one is ever posted it must not
			// demand a person's attention for a commit nobody asked about.
			return "success"
		default:
			// Stopped at limit and Could not run both need a person: a re-run, more
			// credits, or a fix. Distinct from a test failure, and still not a pass.
			return "action_required"
	}
}

/**
 * Whether the Action's own step goes red — FR-9.
 *
 * Only ever governs the step. The check above reports truthfully regardless, so
 * a repo choosing `report` sees a red check and a green build, deliberately.
 *
 * Anything unrecognised — unset, misspelled, a value from a newer config than
 * this Action understands — behaves as `report`. Reddening builds is the one
 * direction a misconfiguration must not fail in.
 */
export function stepShouldFail(buildEffect, outcome) {
	if (buildEffect !== "fail") return false
	// A skipped run is not a bad outcome, it is no outcome. Reddening the step
	// for it would fail every push in a repository that binds only pull
	// requests — which is most of them.
	if (outcome === OUTCOMES.SKIPPED) return false
	return outcome !== OUTCOMES.SUCCEEDED
}
