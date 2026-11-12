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

const nameOf = (r) =>
	String(r?.name ?? "workflow")
		.replace(/[[\]`<>|\r\n]/g, " ")
		.trim() || "workflow"

/**
 * The other runs on a commit, newest first: finished red ones and ones still going.
 * Excludes our own runs.
 */
export function ciOnCommit(runs, { selfRunId, selfWorkflowName } = {}) {
	const others = (runs ?? [])
		.filter((r) => r && String(r.id) !== String(selfRunId) && (!selfWorkflowName || r.name !== selfWorkflowName))
		.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
	const pick = (r) => ({ id: r.id, name: nameOf(r), url: r.html_url })
	return {
		failed: others.filter((r) => r.status === "completed" && RED.has(r.conclusion) && r.html_url).map(pick),
		running: others.filter((r) => IN_FLIGHT.has(r.status)).map(pick),
	}
}

/**
 * A run the comment names explicitly: an Actions run link, or `run <id>`. Returns { id },
 * { error } for a link to another host or repository, or undefined when none is named.
 * Ids are digits only.
 */
export function parseRunReference(text, { repo, serverUrl } = {}) {
	const s = String(text ?? "")
	const link = /https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)/i.exec(s)
	if (link) {
		let host = "github.com"
		try {
			host = new URL(serverUrl || "https://github.com").host
		} catch {
			// Default host.
		}
		const [, linkHost, owner, name, id] = link
		if (linkHost.toLowerCase() !== host.toLowerCase() || `${owner}/${name}`.toLowerCase() !== String(repo ?? "").toLowerCase()) {
			return { error: `That run link is not for ${repo || "this repository"}, so I can't use it.` }
		}
		return { id }
	}
	const bare = /\brun\s+#?(\d{6,})\b/i.exec(s)
	return bare ? { id: bare[1] } : undefined
}

// Words that say what to do, not which workflow to look at.
const NOT_A_NAME = new Set(
	"browserstack explain fix find bad pr prs pull request the a an why what did does do failed failing fail failure build builds run runs this that these on in for please of to and go verdict rca me it is test tests ci check checks job jobs with my our".split(
		" ",
	),
)

/** The newest failed run whose workflow name has a word the comment uses (e.g. "explain e2e"). */
export function matchFailedByName(text, failed) {
	const said = new Set(
		String(text ?? "")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 2 && !NOT_A_NAME.has(w)),
	)
	if (said.size === 0) return undefined
	return (failed ?? []).find((r) =>
		String(r.name)
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.some((w) => said.has(w)),
	)
}

/** Why a run named in a comment can't be used, or { ok, url, name }. */
export function checkNamedRun(run, { prShas = [], selfRunId, selfWorkflowName } = {}) {
	if (!run?.id || !run?.html_url) return { why: "I could not find that run in this repository." }
	if (String(run.id) === String(selfRunId) || (selfWorkflowName && run.name === selfWorkflowName)) {
		return { why: "That is one of Test Companion's own runs." }
	}
	if (!prShas.includes(run.head_sha)) return { why: "That run is not for a commit on this pull request." }
	if (IN_FLIGHT.has(run.status)) return { why: "That run is still going. Ask me again when it finishes." }
	if (run.status !== "completed" || !RED.has(run.conclusion)) {
		return { why: `That run did not fail (it finished as ${run.conclusion ?? "unknown"}).` }
	}
	return { ok: true, url: run.html_url, name: nameOf(run) }
}

const listNames = (runs, max = 5) => {
	const shown = runs.slice(0, max).map((r) => `**${r.name}**`)
	return runs.length > max ? `${shown.join(", ")} and ${runs.length - max} more` : shown.join(", ")
}

/** The reply when nothing has failed yet but CI is still running on the commit. */
export function renderCiStillRunning(sha, running, failed = []) {
	const short = String(sha ?? "").slice(0, 7)
	const done = failed.length ? ` Already failed: ${listNames(failed)}.` : ""
	return `CI is still running on \`${short}\`: ${listNames(running)}.${done} Ask me again when it finishes, and I will look at whatever went red.`
}

/** Which run was looked at, which other failures were not, and how to ask about one. */
export function renderBuildNote(chosen, { otherFailed = [], running = [], ask = "explain" } = {}) {
	if (!chosen) return ""
	const parts = [`Looked at **${chosen.name}** ([run](${chosen.url})).`]
	if (otherFailed.length) {
		parts.push(`Also failed: ${listNames(otherFailed)}. To look at one, ask \`@browserstack ${ask} ${otherFailed[0].name}\` or paste its run link.`)
	}
	if (running.length) parts.push(`Still running: ${listNames(running)}.`)
	return parts.join(" ")
}
