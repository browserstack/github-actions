/**
 * The run's outcome comes from both the exit code and the report file: exit 4
 * covers several causes, and the report is missing if the process was killed.
 */
export const OUTCOMES = Object.freeze({
	SUCCEEDED: "Succeeded",
	TESTS_FAILED: "Tests failed",
	RUN_BROKE: "Run broke",
	STOPPED_AT_LIMIT: "Stopped at limit",
	COULD_NOT_RUN: "Could not run",
	// Nothing ran (draft PR, fork, unaddressed comment, nothing bound to the event).
	SKIPPED: "Skipped",
})

// One `key: value` per line, split on the first colon (values are often URLs).
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

export function resolveOutcome(exitCode, summary = {}) {
	// The report wins over exit 0: a run with an expired session can exit 0 having done nothing.
	if (summary.outcome === "skipped") {
		return OUTCOMES.SKIPPED
	}
	if (exitCode === 0 && summary.outcome && summary.outcome !== "succeeded") {
		return summary.outcome === "failed" ? OUTCOMES.TESTS_FAILED : OUTCOMES.RUN_BROKE
	}

	switch (exitCode) {
		case 0:
			return OUTCOMES.SUCCEEDED
		case 5:
			return OUTCOMES.TESTS_FAILED
		// Exit 4 covers several causes; only the report separates them.
		case 4:
			return summary.error_type === "ceiling_exceeded" ? OUTCOMES.STOPPED_AT_LIMIT : OUTCOMES.RUN_BROKE
		case 2:
			return OUTCOMES.COULD_NOT_RUN
		case 3:
			return OUTCOMES.COULD_NOT_RUN
		case 7:
			return OUTCOMES.COULD_NOT_RUN
		case 6:
			return OUTCOMES.RUN_BROKE
		default:
			return OUTCOMES.RUN_BROKE
	}
}

// Never `neutral`: branch protection treats it as a pass.
export function checkConclusion(outcome) {
	switch (outcome) {
		case OUTCOMES.SUCCEEDED:
			return "success"
		case OUTCOMES.TESTS_FAILED:
			return "failure"
		case OUTCOMES.SKIPPED:
			return "success"
		default:
			return "action_required"
	}
}

const OUTCOME_MARKS = Object.freeze({
	[OUTCOMES.SUCCEEDED]: "✅",
	[OUTCOMES.TESTS_FAILED]: "❌",
	[OUTCOMES.RUN_BROKE]: "💥",
	[OUTCOMES.STOPPED_AT_LIMIT]: "🛑",
	[OUTCOMES.COULD_NOT_RUN]: "⚠️",
	[OUTCOMES.SKIPPED]: "⏭️",
})

export function emojiFor(outcome) {
	return OUTCOME_MARKS[outcome] ?? ""
}

const warnedBuildEffects = new Set()
function warnUnrecognisedBuildEffect(value) {
	if (warnedBuildEffects.has(value)) return
	warnedBuildEffects.add(value)
	const known = Object.values(BUILD_EFFECTS).join(", ")
	process.stdout.write(
		`::warning::Test Companion: build-effect "${value}" is not one of ${known}, so the default (${BUILD_EFFECTS.FAIL_ON_BREAK}) applies and a run that breaks will redden this step.\n`,
	)
}

export const BUILD_EFFECTS = Object.freeze({
	REPORT: "report",
	// Red only when the run itself broke, not on failing tests.
	FAIL_ON_BREAK: "fail-on-break",
	FAIL: "fail",
})

const RUN_DID_NOT_WORK = new Set([OUTCOMES.RUN_BROKE, OUTCOMES.COULD_NOT_RUN, OUTCOMES.STOPPED_AT_LIMIT])

/** The run broke, never started or hit a limit: there is nothing to approve. */
export const runDidNotWork = (outcome) => RUN_DID_NOT_WORK.has(outcome)

/**
 * Whether the Action's step goes red. The check is unaffected. Unknown values
 * act as the default, not `report`; `off` is a legacy synonym for `report`.
 */
export function stepShouldFail(buildEffect, outcome) {
	if (outcome === OUTCOMES.SUCCEEDED || outcome === OUTCOMES.SKIPPED) return false
	const effect = String(buildEffect ?? "")
		.trim()
		.toLowerCase()
	if (effect === BUILD_EFFECTS.REPORT || effect === "off") return false
	if (effect === BUILD_EFFECTS.FAIL) return true
	if (effect !== "" && effect !== BUILD_EFFECTS.FAIL_ON_BREAK) {
		warnUnrecognisedBuildEffect(effect)
	}
	return RUN_DID_NOT_WORK.has(outcome)
}

/**
 * Whether the `go` approval is used up. Failed tests or a hit limit still did
 * work; a run that broke or never started did not, so it can be approved again.
 */
export function approvalWasSpent(outcome) {
	return outcome !== OUTCOMES.RUN_BROKE && outcome !== OUTCOMES.COULD_NOT_RUN && outcome !== OUTCOMES.SKIPPED
}
