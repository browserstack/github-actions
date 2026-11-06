/**
 * Which runs a closed pull request should end.
 *
 * Pure, and separated from the `gh` calls in main.mjs so it can be tested
 * without staging a live run.
 *
 * Two cases that are silent when they go wrong:
 *
 *  - The run doing the cancelling is ITSELF in flight on that commit. Cancel
 *    it and the job disappears mid-reply, telling the person nothing.
 *  - Cancelling means cancelling Test Companion, never the repository's own
 *    build. A comment must not become a way to stop someone else's CI.
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
 * Our in-flight run ids, from the check runs on a commit.
 *
 * Neither obvious route works. `actions/runs?head_sha=` misses every time,
 * because a run started by an issue_comment carries the DEFAULT BRANCH's sha.
 * A run's own `pull_requests` field reports the pull request whose head is the
 * checked-out branch, which is a different pull request.
 *
 * The check run is the handle that holds: posted on the pull request's own
 * head commit, carrying the run id in `external_id`, and written by nothing
 * else under this name.
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
 * `rca`, `fix` and `verdict` all need to know WHICH build failed. A
 * build_failed trigger hands us the run; a comment does not, so it is found
 * here.
 *
 * Returns the run's own URL, the shape `--build` and `--run` accept
 * (`https://github.com/<owner>/<repo>/actions/runs/<id>`).
 *
 * Two runs are never the answer: ours, because explaining our own failure is
 * a mirror rather than an answer, and the one asking, which has not finished.
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
