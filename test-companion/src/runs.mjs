/**
 * Which runs a "stop" should end — STM-5434 FR-35.
 *
 * Pure, and separated from the `gh` calls in main.mjs for the usual reason: the
 * only other way to exercise it is to start a run, comment on it and watch, and
 * the interesting cases here are the ones that are awkward to stage on purpose.
 *
 * Two of those cases are worth stating out loud, because both are silent when
 * they go wrong:
 *
 *   - The run handling the "stop" comment is ITSELF an in-flight run on that
 *     commit. Cancel it and the job doing the cancelling disappears mid-reply,
 *     so the person who asked is told nothing at all.
 *   - "Stop" means stop Test Companion, not stop the repository's own build. A
 *     comment must never become a way to cancel someone else's CI.
 */

/** A run GitHub has not finished with yet. */
const IN_FLIGHT = new Set(["queued", "in_progress", "waiting", "requested", "pending"])

/**
 * The ids to cancel.
 *
 * `selfRunId` is GITHUB_RUN_ID, which arrives as a string while the API returns
 * a number — compared as strings so the two always meet.
 *
 * `workflowName` is optional: without it we cannot tell our runs from the
 * repository's, so the commit match is all that narrows the list. Pass it
 * whenever it is known.
 */
export function chooseRunsToCancel(runs, { selfRunId, headSha, workflowName } = {}) {
	return (runs ?? [])
		.filter((r) => r && IN_FLIGHT.has(r.status))
		.filter((r) => String(r.id) !== String(selfRunId))
		.filter((r) => !headSha || r.head_sha === headSha)
		.filter((r) => !workflowName || r.name === workflowName)
		.map((r) => r.id)
}

/**
 * Our in-flight run ids, from the check runs on a commit — FR-35.
 *
 * Replaces asking GitHub for `actions/runs?head_sha=<the pull request's head>`.
 * That query cannot work for this feature: a run started by an ISSUE_COMMENT
 * carries the DEFAULT BRANCH's sha, because that is what GitHub checks out for
 * that event. So it matched nothing, every time — `stop` answered "nothing is
 * running" with a run plainly in flight, and closing a pull request did not
 * stop its run either.
 *
 * A run's own `pull_requests` field looks like the answer and is not: on an
 * issue_comment run it reports the pull request whose HEAD is the checked-out
 * branch, which is a different pull request. Observed live: a run for #22
 * reporting number 18.
 *
 * The check run is the handle that actually holds. It is posted on the pull
 * request's own head commit, it carries the run id in `external_id`, and
 * nothing else writes a check by this name.
 *
 * `selfRunId` is GITHUB_RUN_ID, a string here and a number from the API, so
 * both sides are compared as strings.
 */
export function runIdsFromChecks(checks, { selfRunId, checkName = "Test Companion" } = {}) {
	const ids = new Set()
	for (const c of checks ?? []) {
		if (!c || c.name !== checkName) continue
		if (!IN_FLIGHT.has(c.status)) continue
		const id = String(c.external_id ?? "").trim()
		// No id means we cannot say WHICH run this check belongs to, and
		// cancelling a guess is worse than cancelling nothing.
		if (!id) continue
		if (id === String(selfRunId)) continue
		ids.add(id)
	}
	return [...ids]
}

/** Conclusions a person reads as "this build is red". */
const RED = new Set(["failure", "cancelled", "timed_out", "startup_failure"])

/**
 * The build a comment means by "the failure" — the newest red run on this
 * commit, or nothing.
 *
 * `rca`, `fix` and `verdict` all need to know WHICH build failed. On a
 * build_failed trigger GitHub hands us the run and plan-run.mjs passes
 * `run.html_url` straight through; from a COMMENT nobody hands us one, so all
 * three failed on the first comment with "Could not run" — while CAPABILITIES
 * advertises them by name and renderUnknownRequest offers them as suggestions.
 *
 * Returns the run's own URL, which is the shape `--build` and `--run` accept
 * (`https://github.com/<owner>/<repo>/actions/runs/<id>`).
 *
 * Two runs are never the answer. Ours, because explaining our own failure is a
 * mirror rather than an answer; and the one asking, which has not finished.
 */
export function latestFailedRun(runs, { selfRunId, selfWorkflowName } = {}) {
	const red = (runs ?? []).filter(
		(r) =>
			r &&
			r.status === "completed" &&
			RED.has(r.conclusion) &&
			r.html_url &&
			String(r.id) !== String(selfRunId) &&
			(!selfWorkflowName || r.name !== selfWorkflowName),
	)
	if (red.length === 0) return undefined
	return red.reduce((a, b) => ((a.id ?? 0) >= (b.id ?? 0) ? a : b)).html_url
}
