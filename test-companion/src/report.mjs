/**
 * What the run leaves behind — STM-3663 FR-27, FR-29.
 *
 * Only the rendering and the decisions live here, with no network calls, so the
 * awkward parts are testable without a runner: whether a preview run is marked
 * as one, and whether a second run adds a second comment or edits the first.
 * The GitHub calls themselves are a thin layer in main.mjs over `gh`, which is
 * preinstalled on every runner and already how this product talks to GitHub.
 */
import { CAPABILITIES } from "./intent.mjs"

/**
 * How a later run finds the comment it wrote earlier — FR-29 wants ONE comment,
 * edited in place, not a new one per run. An HTML comment so a reader never
 * sees it.
 */
export const COMMENT_MARKER = "<!-- test-companion-run -->"

const previewRun = (summary) => summary?.preview === "true"

/**
 * What the run produced, in the words a reviewer actually wants — FR-27.
 *
 * Returns nothing for a run that generates no cases (rca, fix, verdict): a row
 * reading "0 generated" on one of those looks like something went wrong.
 *
 * The case that matters most is cases generated and NONE saved. Left to a bare
 * pair of numbers, "12 generated · 0 saved" reads as success to a skimming
 * reader, which is the exact failure this whole feature exists to prevent — a
 * real run produced 27 cases, reported "Succeeded", and lost all of them.
 */
function producedLines(summary, resultArtifact) {
	const generated = Number(summary.cases_generated ?? 0)
	const saved = Number(summary.cases_saved ?? 0)
	if (!generated && !saved) return []

	const lines = [`**Test cases:** ${generated} generated, ${saved} saved to Test Management.`]
	if (saved > 0 && summary.saved_to) {
		lines.push(`They are in \`${summary.saved_to}\`.`)
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

/**
 * How many failing tests the report names before it stops — FR-28.
 *
 * A suite that loses a hundred tests turns the check into a wall of text
 * nobody reads. The first few plus a count is more useful than all of them,
 * and every one is still annotated on the diff.
 */
const FAILURES_LISTED = 20

/** The failing tests, named, with where they are when that is known. */
function failureLines(failedTests) {
	const failures = failedTests ?? []
	if (failures.length === 0) return []

	const lines = ["**Failed:**", ""]
	for (const t of failures.slice(0, FAILURES_LISTED)) {
		const where = t.file ? ` — \`${t.file}${t.line ? `:${t.line}` : ""}\`` : ""
		lines.push(`- ${t.name}${where}`)
	}
	if (failures.length > FAILURES_LISTED) {
		lines.push(`- …and ${failures.length - FAILURES_LISTED} more.`)
	}
	lines.push("")
	return lines
}

/** The run page's summary — written for every run, including the bad ones. */
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
	workNote,
	extraChecks = [],
	warnings = [],
} = {}) {
	const lines = []
	lines.push(`## Test Companion — ${outcome}`)
	lines.push("")

	// FR-43: both asking and approving need write access, so one person doing
	// both is not an escalation — but a reviewer reading the result should be
	// able to see that no second pair of eyes was involved.
	if (String(approvalNote ?? "").trim()) {
		lines.push(`>${approvalNote}`)
		lines.push("")
	}

	// FR-42: a write that was configured and could not happen must be said out
	// loud — a silent skip reads as "there was nothing to write".
	for (const w of warnings) {
		if (String(w ?? "").trim()) {
			lines.push(`> \u26a0\ufe0f ${w}`)
			lines.push("")
		}
	}

	if (previewRun(summary)) {
		// FR-8. Without this a clean-looking report reads as "the work landed".
		// Not "nothing was written": preview refuses Test Companion's own write
		// TOOLS, and deliberately allows `execute_command` because that is how
		// tests run (preview-tool-policy.ts). A shell command the agent chose can
		// still edit a file or push, so claiming nothing was written overstates
		// the guarantee (review finding, PR #3030).
		lines.push(
			"> **Preview** — Test Companion refused every one of its own write tools, so it created, changed and saved nothing itself. Shell commands the agent ran are not covered by that.",
		)
		lines.push("")
	}

	const rows = [
		["Job", workflow ?? summary.workflow],
		["Trigger", summary.event],
		["Outcome", outcome],
		["Took", summary.duration],
		// Credits, not dollars: it is the unit the bill and the pipeline file's
		// own ceiling are written in, so a figure in dollars would not line up
		// with the limit the run was given.
		["Cost", summary.credits ? `${summary.credits} credits` : ""],
		["CLI", cliVersion],
	].filter(([, v]) => v)

	lines.push("| | |", "|---|---|")
	for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`)
	lines.push("")

	// For `rca` and `verdict` this IS the report — they produce no artefact, only
	// an explanation. It goes directly under the table, above the run links,
	// because it is the thing the person who commented actually asked for.
	// Everything else leaves the view untouched: no answer, nothing rendered.
	if (String(answer ?? "").trim()) {
		lines.push(String(answer).trim(), "")
	}

	lines.push(...failureLines(failedTests))
	lines.push(...producedLines(summary, resultArtifact))

	// FR-43: what the approved run actually saved, and where. The run writes
	// on a runner that is deleted minutes later, so this line is the only
	// record a reviewer gets of what an agent changed in their branch.
	if (String(workNote ?? "").trim()) {
		lines.push(workNote, "")
	}

	if (summary.error_type) {
		lines.push(`**Why it stopped:** \`${summary.error_type}\``, "")
	}
	if (Object.keys(summary).length === 0) {
		// Being explicit beats an empty page: an absent report is itself a finding.
		lines.push("_The run left no report file. That usually means it was cancelled or could not start._", "")
	}
	if (runUrl) lines.push(`[Full run](${runUrl})`)

	// FR-45: the accessibility and visual lines, when the settings asked for them.
	if (extraChecks.length > 0) {
		lines.push("")
		for (const l of extraChecks) lines.push(l)
	}

	return lines.join("\n")
}

/** The pull request comment — the same content, plus the marker. */
export function renderComment(args) {
	return `${renderJobSummary(args)}\n\n${COMMENT_MARKER}`
}

/**
 * Edit our comment, or write the first one.
 *
 * Only a comment WE wrote counts. Matching on the marker alone would let a
 * person quoting our comment in their reply capture the thread, after which
 * every run would overwrite their words.
 */
export function chooseCommentAction(comments) {
	const ours = (comments ?? []).filter((c) => c?.user?.type === "Bot" && (c.body ?? "").includes(COMMENT_MARKER))
	if (ours.length === 0) return { action: "create" }
	// Oldest, so repeated runs converge on one comment even if a duplicate
	// somehow appeared.
	const oldest = ours.reduce((a, b) => (a.id <= b.id ? a : b))
	return { action: "update", id: oldest.id }
}

/**
 * Which commit the "Test Companion" check is attached to.
 *
 * On a pull_request event GITHUB_SHA is the ephemeral MERGE commit, not the
 * branch head. A check posted there does not appear on the pull request and
 * cannot satisfy branch protection — which is exactly what the first live run
 * did. The event's own head sha, which the planner already extracted, is the
 * one a reviewer sees.
 */
export function checkSha(planContext = {}, summary = {}, githubSha) {
	return planContext.sha || summary.sha || githubSha
}

/**
 * Someone without write access asked for a run — FR-33.
 *
 * This used to go only to the job summary, which the person who commented never
 * opens: from where they sat, Test Companion ignored them. One line, naming who
 * can ask, so the answer is where the question was.
 *
 * No COMMENT_MARKER, here or below. A refusal is not a run report, and
 * chooseCommentAction takes the OLDEST marked comment as the one it edits — so
 * a marked refusal would become the place every later run wrote its results.
 */
export function renderNotAuthorized(login, askTeam) {
	const team = String(askTeam ?? "").trim()
	return team
		? `@${login} — this repository has narrowed who can ask Test Companion for a run to the **${team}** team, so write access alone is not enough here.`
		: `@${login} — only someone with write access to this repository can ask Test Companion for a run.`
}

/** We could not place the request — FR-34: reply with what we can do, run nothing. */
export function renderUnknownRequest() {
	const lines = CAPABILITIES.map(({ ask, does }) => `- **${ask}** — ${does}`)
	return [`I could not tell which job that was asking for, so nothing ran. Here is what I can do:`, "", ...lines].join("\n")
}

/** FR-44: a proposal nobody answers is dropped after 24 hours. */
export const PROPOSAL_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * How a waiting proposal is recognised later — STM-5434 FR-43.
 *
 * Keyed to the COMMIT, which is what makes FR-44's "new commits replace the
 * proposal" true without anything having to sweep: once the branch moves, the
 * old proposal simply stops being found, so a "go" can never approve work that
 * was proposed against different code.
 */
export function proposalMarkerFor(sha, requester, workflow) {
	const by = String(requester ?? "").trim()
	// The JOB travels with the proposal. Without it, approving a `fix`
	// proposal ran whatever binding happened to be first in the pipeline file,
	// because the GO path sets no workflow and the CLI then resolves one from
	// the event alone. FR-43 is "what you saw is what runs".
	const job = String(workflow ?? "").trim()
	return `<!-- test-companion-proposal sha=${sha}${by ? ` by=${by}` : ""}${job ? ` workflow=${job}` : ""} -->`
}

/**
 * The ONE pattern for a proposal marker, because the two readers have now
 * drifted twice.
 *
 * findProposal learned about `workflow=`; findSupersededProposal, 200 lines
 * away, did not — its pattern still required ` -->` right after the optional
 * `by=`, so it matched no marker this branch writes and the "your plan is
 * stale" reply silently died back to "No @test-companion mention", which is
 * the exact failure it was written to fix.
 *
 * Groups: 1 = requester, 2 = workflow. Both optional, so markers written
 * before either field existed stay readable.
 *
 * Pass a literal sha to pin the search to one commit, or `([0-9a-f]+)` to
 * match any and capture it.
 */
const markerPattern = (shaPattern) =>
	new RegExp(`<!-- test-companion-proposal sha=${shaPattern}(?: by=([^\\s>]+))?(?: workflow=([^\\s>]+))? -->`)

/** Regex-escape, so a sha is matched literally. */
const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The proposal comment: what the run would do, and how to let it — FR-43. */
export function renderProposal(body, sha, requester, workflow) {
	return [
		body,
		"",
		"Reply **go** to run this for real. Nothing is written until you do — you can edit the list first, or say **stop** to drop it.",
		"",
		proposalMarkerFor(sha, requester, workflow),
	].join("\n")
}

/**
 * The proposal waiting on this commit, if there is one.
 *
 * Only a comment WE wrote counts, for the same reason chooseCommentAction
 * checks: otherwise a person quoting our proposal in their reply could approve
 * their own request.
 *
 * Fails CLOSED on an unreadable timestamp — treated as expired, so the worst
 * case is a fresh proposal rather than approving one of unknown age.
 */
export function findProposal(comments, sha, now = Date.now()) {
	// `by=` is optional so proposals written before the requester was recorded
	// stay approvable rather than becoming stuck.
	// `by=` and `workflow=` are both optional, so proposals written before
	// either was recorded stay approvable rather than becoming stuck.
	const re = markerPattern(escapeRe(sha))
	const ours = (comments ?? []).filter((c) => c?.user?.type === "Bot" && re.test(c.body ?? ""))
	if (ours.length === 0) return undefined
	const newest = ours.reduce((a, b) => (a.id >= b.id ? a : b))
	const age = now - Date.parse(newest.created_at ?? "")
	return {
		id: newest.id,
		expired: !(age <= PROPOSAL_WINDOW_MS),
		requester: re.exec(newest.body ?? "")?.[1],
		// The job the person actually read and approved. Undefined on a
		// proposal written before the marker carried one.
		workflow: re.exec(newest.body ?? "")?.[2],
		// The run has to READ the approved plan to carry it out (FR-43), so the
		// body travels with the decision rather than being fetched again.
		body: newest.body ?? "",
	}
}

/**
 * The plan an approved run must carry out — FR-43.
 *
 * FR-43 allows a reply of "go" WITH OR WITHOUT edits to the case list, and the
 * edits win: someone looked at the proposal and changed it before approving.
 * Handing the run only the original proposal would quietly discard that.
 *
 * The proposal's own marker is stripped. It is bookkeeping, and leaving it in
 * invites the run to read it as an instruction.
 */
/**
 * Did the approver change anything, or just say go? — FR-43.
 *
 * Worth knowing separately from the plan itself: edits made at approval time
 * were reviewed by nobody but the approver, and on a self-approved run by
 * nobody at all. That combination is reported rather than refused — see
 * decideGate — but it cannot be reported if it is not detected.
 */
export function hasApproverEdits(replyText) {
	const reply = String(replyText ?? "").trim()
	if (!reply) return false
	// A bare approval is not an edit. Presenting "go" as one would have the run
	// looking for an instruction nobody gave.
	return !/^(go|approved?)[\s.!]*$/i.test(reply)
}

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

/**
 * How a dropped proposal is remembered — FR-44.
 *
 * The sweep that drops proposals runs nightly. Without a record, it would post
 * a fresh "Action required" check and a fresh comment on the same dead proposal
 * every night for as long as the pull request stayed open.
 */
export function proposalDroppedMarkerFor(sha) {
	return `<!-- test-companion-proposal-dropped sha=${sha} -->`
}

/**
 * Is there a proposal on this commit that has run out of time and not yet been
 * dropped? — FR-44.
 *
 * This exists because FR-44's in-progress check is only safe if something is
 * guaranteed to end it. A proposal nobody answers would otherwise leave the
 * check on "in progress" forever, and anyone who made it a required check is
 * then blocked by a check that never resolves — the exact failure Release 2
 * avoided by posting the tick at the end of a run rather than the start.
 */
export function proposalNeedsDropping(comments, sha, now = Date.now()) {
	const waiting = findProposal(comments, sha, now)
	if (!waiting?.expired) return false
	const dropped = proposalDroppedMarkerFor(sha)
	return !(comments ?? []).some((c) => c?.user?.type === "Bot" && (c.body ?? "").includes(dropped))
}

/**
 * The items out of a `gh api --paginate --slurp` response — FR-29.
 *
 * `--slurp` returns an ARRAY OF PAGES, not a flat array of items, and it wraps
 * even when there is only one page. Verified against gh 2.91.0: twelve pages at
 * per_page=2, and still `[[...]]` at per_page=100.
 *
 * Without this, chooseCommentAction is handed an array of arrays, matches
 * nothing, returns "create" every time, and every run posts a NEW comment —
 * the single-comment guarantee in FR-29, broken by the fix meant to protect it.
 * `--slurp` was added to stop `[...][...]` from failing JSON.parse, which it
 * does; the shape it produces instead was the part that got missed.
 *
 * Objects are not arrays, so flat() leaves an already-flat list alone. That
 * keeps this correct if gh ever changes its mind.
 */
export function flattenPages(slurped) {
	return Array.isArray(slurped) ? slurped.flat() : []
}

/**
 * The accessibility and visual lines on the check — STM-5434 FR-45.
 *
 * Both are silent unless the settings asked for them, and both read their
 * numbers from the run's summary file. Those keys — accessibility_new,
 * accessibility_total, visual_changes, visual_url — are the contract between
 * the run and this report.
 *
 * A check that was asked for and produced no number says so, rather than
 * rendering nothing: an absent line reads as "clean", and claiming a pass for
 * a check that never ran is the worst of the three outcomes.
 */
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

/**
 * May accessibility turn the check red? — FR-45.
 *
 * Only when the settings say so, and only for violations THIS CHANGE
 * introduced. Failing a pull request for the state of a page it never touched
 * is how a gate gets switched off for good, and a gate nobody runs protects
 * nothing.
 *
 * A run that reported no number has not failed: absence is not a violation.
 */
export function accessibilityFailsCheck(summary = {}, { wcag, failOnNew } = {}) {
	if (!String(wcag ?? "").trim() || !failOnNew) return false
	const introduced = Number(summary.accessibility_new)
	return Number.isFinite(introduced) && introduced > 0
}

/**
 * The body of a proposal — FR-38, FR-43.
 *
 * The first live run posted a proposal containing only a report header. The
 * run had designed nine test cases and verified each one by probing the
 * implementation; none of it reached the comment, because the proposal was
 * only ever handed the job summary.
 *
 * A proposal with no plan in it cannot be reviewed, which makes approving it
 * meaningless — so an absent plan says so out loud rather than rendering a
 * confident-looking empty proposal.
 */
export function renderProposalBody({ summary, plan, sizeNote } = {}) {
	const parts = []
	// FR-44's warning goes above the list, where it can still change what the
	// reviewer approves.
	if (String(sizeNote ?? "").trim()) parts.push(sizeNote, "")
	if (String(summary ?? "").trim()) parts.push(summary, "")

	const body = String(plan ?? "").trim()
	// Only `test-pr` writes a separate plan file. For every other job the
	// proposal run is a PREVIEW run — it does the work and writes nothing —
	// so its report above IS what is being approved. Saying "there is nothing
	// here to approve" told the reader to re-run something that had worked.
	const noPlan = String(summary ?? "").trim()
		? "_The report above is what this run would do. Nothing has been written._"
		: "_This run did not produce a plan — there is nothing here to approve. The run log will say why; re-run once that is fixed._"
	parts.push(body || noPlan)
	return parts.join("\n")
}

/**
 * A proposal on this pull request that a newer commit has left behind — FR-44.
 *
 * FR-44 keys a proposal to a commit, so a new commit silently replaces it.
 * That is the right safety behaviour: a plan written against code that has
 * since changed must never be carried out. But silence is the wrong way to
 * say it.
 *
 * Observed live on 2026-10-29: someone replied "go" after the branch moved and
 * was told "No @test-companion mention, so nothing was asked of Test
 * Companion." They had given a valid approval word, and the actual reason was
 * sitting in the comment history.
 *
 * Only our own comments count, so a person quoting the marker cannot
 * manufacture one.
 */
export function findSupersededProposal(comments, sha) {
	const current = String(sha ?? "").trim()
	// Same pattern, sha as a group. Shared so the two cannot drift again.
	const marker = markerPattern("([0-9a-f]+)")
	const stale = (comments ?? []).filter((c) => {
		if (c?.user?.type !== "Bot") return false
		const found = marker.exec(c.body ?? "")
		return Boolean(found) && found[1] !== current
	})
	if (stale.length === 0) return undefined
	// Newest wins: with several old plans, the one they most plausibly meant is
	// the last one we put up.
	const newest = stale.reduce((a, b) => ((a.id ?? 0) >= (b.id ?? 0) ? a : b))
	const found = marker.exec(newest.body ?? "")
	return { sha: found?.[1], requester: found?.[2], id: newest.id }
}

/**
 * Create the "Test Companion" check, or update the one this run already made —
 * FR-48, "one check, never neutral".
 *
 * Every call used to POST. A single run posts up to three times — in progress
 * before the work, the result after it, and the catch-all on a crash — so a
 * pull request collected two or three checks of the same name, and a proposal
 * left ITS in-progress one pending forever because nothing ever completed it.
 * That is the "blocked by a check that never arrives" failure the design is
 * meant to avoid. Reported in review of PR #3101.
 *
 * Keyed by commit: a run can legitimately check two (the head early on, and
 * whatever the report names later), and those are different checks, not an
 * update of one another.
 */
export function checkRequestFor(sha, made) {
	const existing = made?.get?.(sha)
	return existing ? { method: "PATCH", path: `check-runs/${existing}` } : { method: "POST", path: "check-runs" }
}

/**
 * The check a PREVIOUS run left in progress on this commit, if there is one.
 *
 * checkRequestFor only knows what THIS process created. The nightly sweep runs
 * in a different process with an empty memo, so it posted a fresh "Action
 * required" check and left the proposal run's in-progress one pending for the
 * life of the branch — the exact "blocked by a check that never arrives"
 * failure the sweep exists to prevent.
 *
 * Only ours, and only one still running: a completed check is already
 * answered, and another tool's check is none of our business.
 */
export function inFlightCheckId(checks, checkName = "Test Companion") {
	const ours = (checks ?? []).filter((c) => c?.name === checkName && c?.status !== "completed")
	if (ours.length === 0) return undefined
	// Newest, so a stale one from an older run cannot win.
	return ours.reduce((a, b) => ((a.id ?? 0) >= (b.id ?? 0) ? a : b)).id
}
