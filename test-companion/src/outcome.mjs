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
 * One mark per outcome, so the heading reads at a glance.
 *
 * "## Test Companion — Run broke" and "## Test Companion — Succeeded" look the
 * same in a crowded pull request thread, and the one that needs attention is
 * the one that blends in.
 *
 * Deliberately the four GitHub itself uses for the same ideas — a tick for
 * done, a cross for a failing test, a warning for "somebody has to look" —
 * rather than anything decorative. An outcome this Action has never heard of,
 * which a newer CLI could report, gets no mark rather than a crash: losing the
 * mark is cosmetic, losing the report is not.
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

/** What a repository can ask a bad outcome to do to its build — FR-9. */
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
 * Whether the Action's own step goes red — FR-9.
 *
 * Only ever governs the step. The check reports truthfully regardless, so a
 * repository choosing `report` sees a red check and a green build, deliberately.
 *
 * THE DEFAULT CHANGED (STM-5434 demo feedback, item 6). It used to be `report`,
 * so a run that broke passed silently unless somebody had opted in — which is
 * not what anyone looking at a green tick would assume. The default is now
 * `fail-on-break`: a run that did not work reddens the step, a run that worked
 * and found failing tests does not. Making a test RESULT block the build is a
 * larger decision than this one, and `fail` is still there for anyone who wants
 * it.
 *
 * Anything unrecognised behaves as the DEFAULT, which reverses the old rule.
 * That rule — "a misconfiguration must never redden a build" — made sense while
 * `report` was the default. Now that it is not, a typo buying a quieter setting
 * than a fresh install gets is exactly the silent pass item 6 is about. A
 * misspelling leaves you where you would have been having said nothing.
 *
 * `off` is still honoured as a synonym for `report` and is no longer
 * documented: it never did anything `report` did not, and a workflow already
 * saying it must not start failing builds because we stopped advertising the
 * word.
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
	// Anything else is the default, which now reddens — so say which value we
	// did not recognise, or the reddening has no explanation anywhere
	// (STM-5434 review, PR #3286). `build-effect: none` and `warn` are the
	// likely spellings somebody reaches for.
	if (effect !== "" && effect !== BUILD_EFFECTS.FAIL_ON_BREAK) {
		warnUnrecognisedBuildEffect(effect)
	}
	return RUN_DID_NOT_WORK.has(outcome)
}

/**
 * Did this run use up the approval it was given — FR-43.
 *
 * Replying `go` is spent by the run that carries the plan out, so a second
 * `go` cannot quietly run the same work twice. That marker used to be written
 * whatever happened, including to a run that never started.
 *
 * Found live (run 41463749519): an approved `fix` died in under a second
 * because the dedupe claim had no credential to push with. No work, nothing
 * written — and the comment still said the plan was spent. Every later `go` on
 * that commit was refused, a fresh proposal included, and the only way out was
 * a new commit.
 *
 * So the question is whether a RUN happened, not whether it went well. Red
 * tests and a ceiling both did the work and may have written some of it;
 * re-running those would duplicate it and charge again. A run that broke or
 * never started did neither, and the person should be able to simply ask again.
 */
export function approvalWasSpent(outcome) {
	return outcome !== OUTCOMES.RUN_BROKE && outcome !== OUTCOMES.COULD_NOT_RUN && outcome !== OUTCOMES.SKIPPED
}
