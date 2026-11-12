/** Rendering and decisions for the run's comment, check and job summary. No network calls. */
import { CAPABILITIES, isApprovalOnly } from "./intent.mjs"
import { emojiFor } from "./outcome.mjs"
import { ANSWER_JOBS } from "./gate.mjs"

const withMark = (outcome) => {
	const mark = emojiFor(outcome)
	return mark ? `${mark} ${outcome}` : String(outcome ?? "")
}

/** `[#<id>](<url>)` for the comment that asked for this run; "" unless the URL names a comment. */
export function requestLink(url) {
	const u = String(url ?? "")
	const id = /^https:\/\/[^\s)]+#issuecomment-(\d+)$/.exec(u)?.[1]
	return id ? `[#${id}](${u})` : ""
}

/** `@<who> | [#<comment id>](<url>)`; the pipe is escaped so it stays inside the table cell. */
export function askedByCell(askedBy, askedAt) {
	if (!askedBy) return ""
	const link = requestLink(askedAt)
	return link ? `@${askedBy} \\| ${link}` : `@${askedBy}`
}

/**
 * Only comments posted by our own bot login count. Another App or workflow
 * could post our markers, and a `go` would then run their text as the plan.
 */
export const isOurs = (comment, us) => Boolean(us) && comment?.user?.type === "Bot" && comment?.user?.login === us

// Hidden marker on the one status comment automatic runs (no request comment) keep up to date.
export const COMMENT_MARKER = "<!-- test-companion-run -->"

/** Marks the reply to one request, so a re-run of the same job edits it and nothing else does. */
export function requestMarkerFor(requestId) {
	const id = String(requestId ?? "").replace(/\D/g, "")
	return id ? `<!-- test-companion-run request=${id} -->` : COMMENT_MARKER
}

const previewRun = (summary) => summary?.preview === "true"

// Flags generated-but-unsaved cases loudly; bare counts read as success.
function producedLines(summary, resultArtifact) {
	const generated = Number(summary.cases_generated ?? 0)
	const saved = Number(summary.cases_saved ?? 0)
	if (!generated && !saved) return []

	const lines = [`**Test cases:** ${generated} generated, ${saved} saved to Test Management.`]
	if (saved > 0 && summary.saved_to) {
		lines.push(`They are in \`${inertMarkers(summary.saved_to)}\`.`)
	}
	if (saved < generated) {
		lines.push(
			saved === 0
				? "**Nothing was written to Test Management.** Download the result below to keep the cases."
				: "Some of them were not saved. Download the result below for the full list.",
		)
	}
	if (resultArtifact) {
		lines.push(`The full list is in the **${resultArtifact}** artifact on this run.`)
	}
	return [lines.join(" "), ""]
}

const FAILURES_LISTED = 20

/**
 * Break `<!--` in text we did not write (agent answer, test names), so it
 * cannot plant one of our HTML-comment markers. Renders the same.
 */
function inertMarkers(text) {
	return String(text).replace(/<!--/g, "&lt;!--")
}

function failureLines(failedTests) {
	const failures = failedTests ?? []
	if (failures.length === 0) return []

	const lines = ["**Failed:**", ""]
	for (const t of failures.slice(0, FAILURES_LISTED)) {
		const n = Number(t.line)
		const at = Number.isInteger(n) && n > 0 ? `:${n}` : ""
		const where = t.file ? ` — \`${inertMarkers(t.file)}${at}\`` : ""
		lines.push(`- ${inertMarkers(t.name)}${where}`)
	}
	if (failures.length > FAILURES_LISTED) {
		lines.push(`- …and ${failures.length - FAILURES_LISTED} more.`)
	}
	lines.push("")
	return lines
}

export function renderJobSummary({
	workflow,
	outcome,
	summary = {},
	runUrl,
	cliVersion,
	resultArtifact,
	failedTests,
	approvalNote,
	answer,
	askedBy,
	askedAt,
	approvedPlan,
	workNote,
	extraChecks = [],
	warnings = [],
	errorLine,
	buildNote,
	planWorkflow,
} = {}) {
	const lines = []
	lines.push(`## Test Companion — ${withMark(outcome)}`)
	lines.push("")

	const why = oneLine(errorLine)
	if (why) {
		lines.push(`> **Why:** ${inertMarkers(why)}`)
		lines.push("")
	}

	if (String(approvalNote ?? "").trim()) {
		lines.push(`>${inertMarkers(approvalNote)}`)
		lines.push("")
	}

	if (String(summary.dedupe ?? "").trim()) {
		lines.push(`> \u26a0\ufe0f Ran without duplicate protection: ${inertMarkers(summary.dedupe)}`)
		lines.push("")
	}

	for (const w of warnings) {
		if (String(w ?? "").trim()) {
			lines.push(`> \u26a0\ufe0f ${inertMarkers(w)}`)
			lines.push("")
		}
	}

	if (String(buildNote ?? "").trim()) {
		lines.push(`> ${inertMarkers(oneLine(buildNote))}`)
		lines.push("")
	}

	if (previewRun(summary)) {
		// Explain and find-the-bad-PR always run this way on purpose; the banner reads as "nothing happened".
		// Decided by the job asked for, never by the agent-written summary.
		lines.push(
			ANSWER_JOBS.has(planWorkflow)
				? "> Read-only: this job explains what happened; nothing it does is saved."
				: // Preview blocks Test Companion's own write tools, not shell commands the agent runs.
					"> **Preview** — Test Companion refused every one of its own write tools, so it created, changed and saved nothing itself. Shell commands the agent ran are not covered by that.",
		)
		lines.push("")
	}

	const rows = [
		["Job", workflow ?? summary.workflow],
		["Trigger", summary.event],
		["Outcome", withMark(outcome)],
		["Took", summary.duration],
		["Cost", summary.credits ? `${summary.credits} credits` : ""],
		["CLI", cliVersion],
		["Asked by", askedByCell(askedBy, askedAt)],
		["Plan", approvedPlan?.url ? `[#${approvedPlan.id}](${approvedPlan.url})` : ""],
	].filter(([, v]) => v)

	lines.push("| | |", "|---|---|")
	for (const [k, v] of rows) lines.push(`| ${k} | ${inertMarkers(v)} |`)
	lines.push("")

	if (String(answer ?? "").trim()) {
		lines.push(inertMarkers(String(answer).trim()), "")
	}

	lines.push(...failureLines(failedTests))
	lines.push(...producedLines(summary, resultArtifact))

	if (String(workNote ?? "").trim()) {
		lines.push(inertMarkers(workNote), "")
	}

	if (summary.error_type) {
		lines.push(`**Why it stopped:** \`${inertMarkers(summary.error_type)}\``, "")
	}
	if (Object.keys(summary).length === 0) {
		lines.push("_The run left no report file. That usually means it was cancelled or could not start._", "")
	}
	if (runUrl) lines.push(`[Full run](${runUrl})`)

	if (extraChecks.length > 0) {
		lines.push("")
		for (const l of extraChecks) lines.push(l)
	}

	return lines.join("\n")
}

// GitHub's limit on an issue comment body; over it the API rejects the whole comment.
export const COMMENT_LIMIT = 65536

function cutShortNote(runUrl) {
	const where = runUrl ? `the [run page](${runUrl})` : "the run's summary"
	return `\n\n_Cut short to fit a comment. The full version is on ${where}._`
}

/** `marker` is requestMarkerFor(id) for a reply to a request; the shared status marker otherwise. */
export function renderComment(args, marker = COMMENT_MARKER) {
	return renderWithin(args, COMMENT_LIMIT, `\n\n${marker}`)
}

// GitHub's cap on a check run's summary; over it the check is never completed.
export const CHECK_SUMMARY_LIMIT = 65535

export function renderCheckSummary(args) {
	return renderWithin(args, CHECK_SUMMARY_LIMIT, "")
}

/** Render within `limit`, cutting the agent's answer first so the table, links and marker survive. */
function renderWithin(args, limit, tail) {
	const body = renderJobSummary(args)
	if (body.length + tail.length <= limit) return body + tail

	const note = cutShortNote(args?.runUrl)
	const answer = inertMarkers(String(args?.answer ?? "").trim())
	if (answer) {
		const overhead = renderJobSummary({ ...args, answer: "x" }).length - 1
		const room = limit - overhead - tail.length - note.length
		if (room > 0) {
			// Cut at a nearby line break, so a code fence is less likely to be left open.
			const cut = answer.slice(0, room)
			const nl = cut.lastIndexOf("\n")
			const kept = nl > room / 2 ? cut.slice(0, nl) : cut
			return renderJobSummary({ ...args, answer: kept + note }) + tail
		}
	}
	const rest = renderJobSummary({ ...args, answer: undefined })
	return rest.slice(0, Math.max(0, limit - tail.length - note.length)) + note + tail
}

/**
 * Only our own marked comment; a person quoting it must not capture the thread. With a
 * `requestId`, only that request's own reply is ever edited: one reply per request.
 */
export function chooseCommentAction(comments, us, { requestId } = {}) {
	const marker = requestId ? requestMarkerFor(requestId) : COMMENT_MARKER
	const ours = (comments ?? []).filter((c) => isOurs(c, us) && (c.body ?? "").includes(marker))
	if (ours.length === 0) return { action: "create" }
	const oldest = ours.reduce((a, b) => (a.id <= b.id ? a : b))
	return { action: "update", id: oldest.id }
}

// On pull_request, GITHUB_SHA is the merge commit; the check must go on the head sha.
export function checkSha(planContext = {}, summary = {}, githubSha) {
	return planContext.sha || summary.sha || githubSha
}

// No COMMENT_MARKER on refusals, or chooseCommentAction would reuse them for run reports.
export function renderNotAuthorized(login, askTeam) {
	const team = String(askTeam ?? "").trim()
	return team
		? `@${login} — this repository has narrowed who can ask Test Companion for a run to the **${team}** team, so write access alone is not enough here.`
		: `@${login} — only someone with write access to this repository can ask Test Companion for a run.`
}

export function renderUnknownRequest() {
	const lines = CAPABILITIES.map(({ ask, does }) => `- **${ask}** — ${does}`)
	return [`I could not tell which job that was asking for, so nothing ran. Here is what I can do:`, "", ...lines].join("\n")
}

export function renderStopRemoved() {
	return [
		"`stop` is no longer something I do.",
		"",
		"To end a run that is going, use **Cancel workflow** on the run's own page — GitHub does that more reliably than I could.",
		"",
		"To get rid of a plan waiting for approval, just leave it. It stops being approvable after 24 hours, and a nightly sweep then closes it off — so the check can sit on **Action required** for up to another day before it resolves. If that check is required on your repository, merge is blocked until it does.",
	].join("\n")
}

export const PROPOSAL_WINDOW_MS = 24 * 60 * 60 * 1000

// Keyed to the commit, so a new push makes an old proposal unapprovable.
export function proposalMarkerFor(sha, requester, workflow) {
	const by = String(requester ?? "").trim()
	const job = String(workflow ?? "").trim()
	return `<!-- test-companion-proposal sha=${sha}${by ? ` by=${by}` : ""}${job ? ` workflow=${job}` : ""} -->`
}

// Groups: 1 = sha, 2 = requester, 3 = workflow. The sha is captured and compared,
// never built into the regex.
const MARKER = /<!-- test-companion-proposal sha=([^\s>]+)(?: by=([^\s>]+))?(?: workflow=([^\s>]+))? -->/

// The last marker, since ours ends the comment and anything earlier could be planted.
const readMarker = (body) => {
	const all = [...String(body ?? "").matchAll(new RegExp(MARKER.source, "g"))]
	const found = all.at(-1)
	return found ? { sha: found[1], requester: found[2], workflow: found[3] } : undefined
}

// The commit our in-progress check went on (the PR head), which on a comment run is not GITHUB_SHA.
export function checkSubjectFor(made, fallbackSha) {
	for (const sha of made?.keys?.() ?? []) return sha
	return fallbackSha
}

// Exact match against enabled jobs; the name reaches the CLI's command line.
export function isApprovableJob(workflow, enabledWorkflows) {
	const job = String(workflow ?? "")
	return job !== "" && !job.startsWith("-") && (enabledWorkflows ?? []).includes(job)
}

export function renderProposal(body, sha, requester, workflow) {
	return [
		body,
		"",
		"Reply **go** to run this for real. Nothing is written until you do. To change the list first, reply **@browserstack go** with your edits. Leave it and it stops being approvable after a day.",
		"",
		proposalMarkerFor(sha, requester, workflow),
	].join("\n")
}

/** "approved", "dropped", or undefined when no plan on this commit was used. */
export function proposalAlreadyUsed(comments, sha, us, workflow) {
	const want = String(sha ?? "").trim()
	const job = String(workflow ?? "").trim()
	const here = spentPlans(comments, us).filter((m) => m.sha === want && (!m.workflow || !job || m.workflow === job))
	if (here.some((m) => m.kind === "consumed")) return "approved"
	if (here.some((m) => m.kind === "dropped")) return "dropped"
	return undefined
}

/**
 * Is this plan comment spent? Returns the marker that spent it, or undefined.
 *
 * A marker naming a plan always spends that plan. An approval ("consumed") also spends every
 * other plan of the same job on the commit that already existed when it was recorded (posted
 * before the comment carrying the marker), older or newer than the approved one: one approval
 * settles that job on that commit, so neither a second `go` nor the nightly sweep acts on the
 * others. Plans posted after it stay approvable. Dropping an expired plan spends only it and
 * older plans of its job, never a newer plan that may still be waiting. A marker naming no job
 * spends only its named plan. An older marker without a plan id spends the plans of its job
 * (or every job, if it names none) posted up to the comment carrying it.
 */
function planSpentBy(planComment, marks) {
	const id = Number(planComment?.id)
	const job = readMarker(planComment?.body)?.workflow ?? ""
	return marks.find((m) => {
		if (m.plan) {
			const named = Number(m.plan)
			if (id === named) return true
			if (!m.workflow || m.workflow !== job) return false
			return m.kind === "consumed" ? id < Number(m.host) : id < named
		}
		const sameJob = !m.workflow || m.workflow === job
		return sameJob && id <= Number(m.host)
	})
}

/** The reply to `go #<id>` when that plan can't be approved; `spentAs` is from planSpentState. */
export function unavailablePlanReply(spentAs, id, sha) {
	const plan = `Plan \`#${String(id ?? "").replace(/\D/g, "")}\``
	if (spentAs === "superseded") {
		return (
			"A different plan for this job on this commit was already approved, so this one no longer applies. " +
			"Push a new commit or ask again to get a fresh plan."
		)
	}
	if (spentAs === "approved" || spentAs === "dropped") {
		return (
			`${plan} was already ${spentAs === "approved" ? "approved and run" : "dropped"}, so there is nothing left to approve on it. ` +
			"Reply **go** on its own to approve the newest plan, or ask me again for a fresh one."
		)
	}
	return (
		`I have no plan \`#${String(id ?? "").replace(/\D/g, "")}\` still waiting on \`${String(sha ?? "").slice(0, 7)}\`. ` +
		"It may have been written against an earlier commit. Reply **go** on its own to approve the most recent one."
	)
}

/**
 * "approved" or "dropped" when the plan comment `id` itself was approved or dropped,
 * "superseded" when another plan of its job on the commit was approved instead, else undefined.
 */
export function planSpentState(comments, id, us) {
	const plan = (comments ?? []).find((c) => isOurs(c, us) && String(c.id) === String(id) && readMarker(c.body))
	if (!plan) return undefined
	const marks = spentPlans(comments, us).filter((m) => m.sha === readMarker(plan.body).sha)
	// Its own fate first: a marker naming this plan says exactly what happened to it.
	const own = marks.find((m) => m.plan && Number(m.plan) === Number(plan.id))
	const hit = own ?? planSpentBy(plan, marks)
	if (!hit) return undefined
	if (hit.kind === "dropped") return "dropped"
	return hit.plan && Number(hit.plan) !== Number(plan.id) ? "superseded" : "approved"
}


// Only our own comments count; an unreadable timestamp counts as expired.
export function findProposal(comments, sha, now = Date.now(), us, opts = {}) {
	const want = String(sha ?? "").trim()
	// Spent per plan, so approving one leaves a newer plan (same job or not) waiting.
	const spent = spentPlans(comments, us).filter((m) => m.sha === want)

	let ours = (comments ?? []).filter((c) => isOurs(c, us) && readMarker(c.body)?.sha === want)
	ours = ours.filter((c) => !planSpentBy(c, spent))
	// `go <id>` picks one plan when several are waiting.
	const named = String(opts?.id ?? "").trim()
	if (named) ours = ours.filter((c) => String(c.id) === named)
	if (ours.length === 0) return undefined
	const newest = ours.reduce((a, b) => (a.id >= b.id ? a : b))
	const age = now - Date.parse(newest.created_at ?? "")
	const mark = readMarker(newest.body)
	return {
		id: newest.id,
		url: newest.html_url,
		expired: !(age <= PROPOSAL_WINDOW_MS),
		requester: mark?.requester,
		workflow: mark?.workflow,
		body: newest.body ?? "",
	}
}

export function hasApproverEdits(replyText) {
	const reply = String(replyText ?? "").trim()
	if (!reply) return false
	return !isApprovalOnly(reply)
}

// Edits in the `go` reply win over the proposal.
export function renderApprovedPlan(proposalBody, replyText) {
	const plan = String(proposalBody ?? "")
		.replace(/<!-- test-companion-proposal[^>]*-->/g, "")
		.trim()

	const reply = String(replyText ?? "").trim()
	const parts = ["# The approved plan", "", plan]
	if (hasApproverEdits(reply)) {
		parts.push("", "# Changes the approver made", "", reply, "", "Where these differ from the plan above, these win.")
	}
	return parts.join("\n")
}

// Spent-plan markers, so neither a second `go` nor the nightly sweep acts on a finished plan.
// `planId` is the plan comment spent; without it the marker covers older plans (see planSpentBy).
export function proposalConsumedMarkerFor(sha, workflow, planId) {
	return `<!-- test-companion-proposal-consumed sha=${String(sha ?? "")}${jobField(workflow)}${planField(planId)} -->`
}

export function proposalDroppedMarkerFor(sha, workflow, planId) {
	return `<!-- test-companion-proposal-dropped sha=${String(sha ?? "")}${jobField(workflow)}${planField(planId)} -->`
}

function jobField(workflow) {
	const job = String(workflow ?? "").trim()
	return job ? ` workflow=${job}` : ""
}

function planField(planId) {
	const id = String(planId ?? "").replace(/\D/g, "")
	return id ? ` plan=${id}` : ""
}

const SPENT_MARKER =
	/<!-- test-companion-proposal-(consumed|dropped) sha=([^\s>]+)(?: workflow=([^\s>]+))?(?: plan=(\d+))? -->/g

function spentPlans(comments, us) {
	const out = []
	for (const c of comments ?? []) {
		if (!isOurs(c, us)) continue
		for (const m of String(c.body ?? "").matchAll(SPENT_MARKER)) {
			out.push({ kind: m[1], sha: m[2], workflow: m[3], plan: m[4], host: c.id })
		}
	}
	return out
}

// An expired plan holds an in-progress check that would otherwise never complete.
export function proposalNeedsDropping(comments, sha, now = Date.now(), us) {
	return Boolean(findProposal(comments, sha, now, us)?.expired)
}

// `gh api --paginate --slurp` returns an array of pages, even for a single page.
export function flattenPages(slurped) {
	return Array.isArray(slurped) ? slurped.flat() : []
}

// A requested check with no number says so; a missing line would read as clean.
export function renderExtraChecks(summary = {}, { wcag, visual } = {}) {
	const lines = []
	const level = String(wcag ?? "").trim()

	if (level) {
		const introduced = summary.accessibility_new
		if (introduced === undefined) {
			lines.push(`**Accessibility (WCAG ${level.toUpperCase()}):** no result reported by this run.`)
		} else {
			const total = summary.accessibility_total
			lines.push(
				`**Accessibility (WCAG ${level.toUpperCase()}):** ${introduced} introduced by this change` +
					(total === undefined ? "." : `, ${total} on the page in all.`),
			)
		}
	}

	if (visual) {
		const changes = summary.visual_changes
		if (changes === undefined) {
			lines.push("**Visual:** no result reported by this run.")
		} else {
			const link = summary.visual_url ? ` ${summary.visual_url}` : ""
			lines.push(`**Visual:** ${changes} changes awaiting review.${link}`)
		}
	}
	return lines
}

// Only violations this change introduced, and only when configured.
export function accessibilityFailsCheck(summary = {}, { wcag, failOnNew } = {}) {
	if (!String(wcag ?? "").trim() || !failOnNew) return false
	const introduced = Number(summary.accessibility_new)
	return Number.isFinite(introduced) && introduced > 0
}

// A proposal with no plan says so rather than looking approvable.
export function renderProposalBody({ summary, plan, sizeNote } = {}) {
	const parts = []
	if (String(sizeNote ?? "").trim()) parts.push(sizeNote, "")
	// The plan is agent-written; escape markers so it cannot redirect a `go`.
	const safeSummary = inertMarkers(String(summary ?? ""))
	if (safeSummary.trim()) parts.push(safeSummary, "")

	const body = inertMarkers(String(plan ?? "").trim())
	// Skip the plan when the summary above already contains the same text.
	const squash = (t) =>
		String(t ?? "")
			.replace(/\s+/g, " ")
			.trim()
	const alreadyAbove = body !== "" && squash(safeSummary).includes(squash(body))
	// Without a plan file, the preview report above is what is being approved.
	const noPlan = String(summary ?? "").trim()
		? "_The report above is what this run would do. Nothing has been written._"
		: "_This run did not produce a plan — there is nothing here to approve. The run log will say why; re-run once that is fixed._"
	parts.push(alreadyAbove ? noPlan : body || noPlan)
	return parts.join("\n")
}

// A proposal left behind by a newer commit, so a late `go` can be told why it no longer applies.
export function findSupersededProposal(comments, sha, us) {
	const current = String(sha ?? "").trim()
	const stale = (comments ?? []).filter((c) => {
		if (!isOurs(c, us)) return false
		const found = readMarker(c.body)
		return Boolean(found) && found.sha !== current
	})
	if (stale.length === 0) return undefined
	const newest = stale.reduce((a, b) => ((a.id ?? 0) >= (b.id ?? 0) ? a : b))
	const found = readMarker(newest.body)
	return { sha: found?.sha, requester: found?.requester, id: newest.id }
}

// One check per commit per run: PATCH the one we made, POST otherwise.
export function checkRequestFor(sha, made) {
	const existing = made?.get?.(sha)
	return existing ? { method: "PATCH", path: `check-runs/${existing}` } : { method: "POST", path: "check-runs" }
}

// An in-progress check left by an earlier run, so the sweep completes it instead of adding another.
export function inFlightCheckId(checks, checkName = "Test Companion") {
	const ours = (checks ?? []).filter((c) => c?.name === checkName && c?.status !== "completed")
	if (ours.length === 0) return undefined
	return ours.reduce((a, b) => ((a.id ?? 0) >= (b.id ?? 0) ? a : b)).id
}

/** One line of at most 300 characters, for an error quoted in a comment. */
function oneLine(text) {
	const line = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim()
	return line.length > 300 ? `${line.slice(0, 299)}…` : line
}
