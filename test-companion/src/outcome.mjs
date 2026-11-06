/**
 * What happened, in five words.
 *
 * The CLI distinguishes these cases across two channels, and neither is
 * sufficient alone: the exit code is a stable contract but exit 4 covers a
 * crash, a time ceiling AND a version-pin mismatch, while the report file
 * separates them but is absent if the process was killed.
 *
 * Three separate questions, kept apart deliberately:
 *  - what happened → resolveOutcome (the five labels)
 *  - what the check says → checkConclusion
 *  - whether the step is red → stepShouldFail
 *
 * The check always reports truthfully. The build effect only governs the step.
 */

/** The five outcomes, spelled exactly. */
export const OUTCOMES = Object.freeze({
	SUCCEEDED: "Succeeded",
	TESTS_FAILED: "Tests failed",
	RUN_BROKE: "Run broke",
	STOPPED_AT_LIMIT: "Stopped at limit",
	COULD_NOT_RUN: "Could not run",
	// Not one of the five. Those describe a run that HAPPENED; this says none
	// did — a draft PR, a fork, an unaddressed comment, no pipeline file, or
	// an event nothing is bound to.
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
	// Nothing was bound to this event, so nothing ran. Checked before the
	// report-wins rule below, which would otherwise read "not succeeded" as a
	// breakage and redden a commit that was never meant to run anything.
	//
	// The report then wins over a success exit code: a run with an expired
	// BrowserStack session can exit 0 having done nothing at all, which a CI
	// step checking only the exit code reads as green.
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
		// ExitTaskBlocked: the turn finished but the task could not be
		// performed — plan, entitlement, or a refusal.
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
 * What the "Test Companion" check says.
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
 * One mark per outcome, so the heading reads at a glance in a crowded thread.
 *
 * Deliberately the ones GitHub itself uses for the same ideas. An outcome a
 * newer CLI reports and this Action has never heard of gets no mark rather
 * than a crash: losing the mark is cosmetic, losing the report is not.
 */
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

/**
 * A workflow annotation, because that is where somebody looking at a newly-red
 * build will be.
 */
const warnedBuildEffects = new Set()
function warnUnrecognisedBuildEffect(value) {
	// Once per distinct value, not once per process: a run only ever sees one
	// setting, so this is "once" in practice, and it stays observable when
	// several are exercised in the same process.
	if (warnedBuildEffects.has(value)) return
	warnedBuildEffects.add(value)
	const known = Object.values(BUILD_EFFECTS).join(", ")
	process.stdout.write(
		`::warning::Test Companion: build-effect "${value}" is not one of ${known}, so the default (${BUILD_EFFECTS.FAIL_ON_BREAK}) applies and a run that breaks will redden this step.\n`,
	)
}

/** What a repository can ask a bad outcome to do to its build. */
export const BUILD_EFFECTS = Object.freeze({
	/** Never red. The check still reports truthfully. */
	REPORT: "report",
	/** Red when the RUN broke. Green when the run worked and the tests did not. */
	FAIL_ON_BREAK: "fail-on-break",
	/** Red on anything that is not a success, test failures included. */
	FAIL: "fail",
})

/**
 * The run itself did not work: it crashed, it never started, or it hit a
 * ceiling. Distinct from a test failure, which is a RESULT — the run did its
 * job and the answer was no.
 */
const RUN_DID_NOT_WORK = new Set([OUTCOMES.RUN_BROKE, OUTCOMES.COULD_NOT_RUN, OUTCOMES.STOPPED_AT_LIMIT])

/**
 * Whether the Action's own step goes red.
 *
 * Only ever governs the step. The check reports truthfully regardless, so a
 * repository choosing `report` sees a red check and a green build by choice.
 *
 * The default is `fail-on-break`: a run that did not work reddens the step, a
 * run that worked and found failing tests does not. Making a test RESULT
 * block the build is a larger decision, and `fail` is there for anyone who
 * wants it.
 *
 * Anything unrecognised behaves as the DEFAULT rather than as `report`, so a
 * typo cannot buy a quieter setting than a fresh install gets.
 *
 * `off` is still honoured as a synonym for `report`, undocumented: a workflow
 * already saying it must not start failing builds because we stopped
 * advertising the word.
 */
export function stepShouldFail(buildEffect, outcome) {
	// Neither of these is a bad outcome. A skipped run is NO outcome, and
	// reddening the step for one would fail every push in a repository that
	// binds only pull requests — which is most of them.
	if (outcome === OUTCOMES.SUCCEEDED || outcome === OUTCOMES.SKIPPED) return false
	const effect = String(buildEffect ?? "")
		.trim()
		.toLowerCase()
	if (effect === BUILD_EFFECTS.REPORT || effect === "off") return false
	if (effect === BUILD_EFFECTS.FAIL) return true
	// Anything else is the default, which reddens — so say which value we did
	// not recognise, or the reddening has no explanation anywhere. `none` and
	// `warn` are the likely spellings somebody reaches for.
	if (effect !== "" && effect !== BUILD_EFFECTS.FAIL_ON_BREAK) {
		warnUnrecognisedBuildEffect(effect)
	}
	return RUN_DID_NOT_WORK.has(outcome)
}

/**
 * Did this run use up the approval it was given?
 *
 * Replying `go` is spent by the run that carries the plan out, so a second
 * `go` cannot quietly run the same work twice.
 *
 * The question is whether a RUN happened, not whether it went well. Red tests
 * and a ceiling both did the work and may have written some of it;
 * re-running those would duplicate it and charge again. A run that broke or
 * never started did neither, so the person can simply ask again — otherwise a
 * `fix` that dies in a second leaves the commit unapprovable for good.
 */
export function approvalWasSpent(outcome) {
	return outcome !== OUTCOMES.RUN_BROKE && outcome !== OUTCOMES.COULD_NOT_RUN && outcome !== OUTCOMES.SKIPPED
}
