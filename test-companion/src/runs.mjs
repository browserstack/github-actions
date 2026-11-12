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

const tokens = (text) =>
	String(text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)

/**
 * The failed run a comment names by workflow (e.g. "explain e2e"). The whole workflow name,
 * as words, wins (longest first, so "Lint Checks" beats "Lint"); otherwise every significant
 * word of a name must appear, the run with the most such words wins, ties go to the newest.
 * `failed` is newest first. Returns undefined when no workflow is named.
 */
export function matchFailedByName(text, failed) {
	const said = tokens(text)
	const padded = ` ${said.join(" ")} `
	const runs = failed ?? []
	let best
	let bestLen = 0
	for (const r of runs) {
		const name = tokens(r.name)
		if (name.length && padded.includes(` ${name.join(" ")} `) && name.length > bestLen) {
			best = r
			bestLen = name.length
		}
	}
	if (best) return best
	const saidSet = new Set(said)
	let most = 0
	for (const r of runs) {
		const words = tokens(r.name).filter((w) => w.length >= 2 && !NOT_A_NAME.has(w))
		if (words.length && words.every((w) => saidSet.has(w)) && words.length > most) {
			best = r
			most = words.length
		}
	}
	return best
}

/** The reply when GitHub could not be asked about the builds; never "nothing failed". */
export const LOOKUP_FAILED_REPLY =
	"I couldn't look up this pull request's builds on GitHub just now, so I can't tell which one failed. Please ask me again in a minute."

/**
 * A `gh api` result as found, not found (HTTP 404), or failed (anything else), so a lookup
 * that went wrong is never read as "no such run" or "nothing failed".
 */
export function classifyLookup(result) {
	if (result && result.status === 0) {
		try {
			return { found: JSON.parse(result.stdout) }
		} catch {
			return { failed: true }
		}
	}
	return /HTTP 404|Not Found/i.test(`${result?.stderr ?? ""}${result?.stdout ?? ""}`) ? { notFound: true } : { failed: true }
}

// GitHub lists at most this many commits of a pull request.
export const PR_COMMIT_LIST_LIMIT = 250

/**
 * The pull request's commit ids from a `--paginate --slurp` listing, always including the
 * head. `complete` is false when the listing failed or may have been cut off at GitHub's limit.
 */
export function prCommitShas(slurped, headSha) {
	const listed = Array.isArray(slurped)
		? slurped
				.flat()
				.map((c) => c?.sha)
				.filter(Boolean)
		: []
	const shas = [...new Set([...listed, headSha].filter(Boolean))]
	return { shas, complete: Array.isArray(slurped) && listed.length < PR_COMMIT_LIST_LIMIT }
}

/** Why a run named in a comment can't be used, or { ok, url, name }. */
export function checkNamedRun(run, { prShas = [], shasComplete = true, selfRunId, selfWorkflowName } = {}) {
	if (!run?.id || !run?.html_url) return { why: "I could not find that run in this repository." }
	if (String(run.id) === String(selfRunId) || (selfWorkflowName && run.name === selfWorkflowName)) {
		return { why: "That is one of Test Companion's own runs." }
	}
	// Fails closed: a run with no commit id never matches.
	if (!run.head_sha || !prShas.includes(run.head_sha)) {
		return {
			why: shasComplete
				? "That run is not for a commit on this pull request."
				: "I couldn't list all of this pull request's commits, so I can only use runs on its latest commit. Name a run from the latest commit, or ask without naming one.",
		}
	}
	if (IN_FLIGHT.has(run.status)) return { why: "That run is still going. Ask me again when it finishes." }
	if (run.status !== "completed" || !RED.has(run.conclusion)) {
		return { why: `That run did not fail (it finished as ${run.conclusion ?? "unknown"}).` }
	}
	return { ok: true, url: run.html_url, name: nameOf(run) }
}

const listNames = (runs, max = 5) => {
	// A code span: a workflow name can't mention anyone, link, or format (nameOf strips backticks).
	const shown = runs.slice(0, max).map((r) => `\`${r.name}\``)
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
	const parts = [`Looked at \`${chosen.name}\` ([run](${chosen.url})).`]
	if (otherFailed.length) {
		parts.push(`Also failed: ${listNames(otherFailed)}. To look at one, ask \`@browserstack ${ask} run ${otherFailed[0].id}\` or paste its run link.`)
	}
	if (running.length) parts.push(`Still running: ${listNames(running)}.`)
	return parts.join(" ")
}
