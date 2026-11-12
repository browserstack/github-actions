/**
 * Which runs to cancel. Never the cancelling run itself, and never the
 * repository's own builds.
 */

const IN_FLIGHT = new Set(["queued", "in_progress", "waiting", "requested", "pending"])

/** Ids are compared as strings: GITHUB_RUN_ID is a string, the API's a number. */
export function chooseRunsToCancel(runs, { selfRunId, headSha, workflowName } = {}) {
	return (runs ?? [])
		.filter((r) => r && IN_FLIGHT.has(r.status))
		.filter((r) => String(r.id) !== String(selfRunId))
		.filter((r) => !headSha || r.head_sha === headSha)
		.filter((r) => !workflowName || r.name === workflowName)
		.map((r) => r.id)
}

/**
 * Our in-flight run ids, from our check runs' `external_id`. A comment-started
 * run carries the default branch's sha, so `actions/runs?head_sha=` misses it.
 */
export function runIdsFromChecks(checks, { selfRunId, checkName = "Test Companion" } = {}) {
	const ids = new Set()
	for (const c of checks ?? []) {
		if (!c || c.name !== checkName) continue
		if (!IN_FLIGHT.has(c.status)) continue
		const id = String(c.external_id ?? "").trim()
		if (!id) continue
		if (id === String(selfRunId)) continue
		ids.add(id)
	}
	return [...ids]
}

const RED = new Set(["failure", "cancelled", "timed_out", "startup_failure"])

/** URL of the newest failed run on this commit, excluding our own runs. */
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
