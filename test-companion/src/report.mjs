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
import { emojiFor } from "./outcome.mjs"

/**
 * The outcome with its mark in front — never instead of the words, so a reader
 * with images off, or a screen reader, still gets the whole outcome. An
 * outcome with no mark reads exactly as it did before.
 */
const withMark = (outcome) => {
	const mark = emojiFor(outcome)
	return mark ? `${mark} ${outcome}` : String(outcome ?? "")
}

/**
 * How a later run finds the comment it wrote earlier — FR-29 wants ONE comment,
 * edited in place, not a new one per run. An HTML comment so a reader never
 * sees it.
 */
/**
 * Is this comment one WE wrote? — review of #3101, M2.
 *
 * "Any bot" was the old answer, and it was not good enough. Another App on
 * the repository, or `github-actions[bot]` driven by any other workflow in
 * it, could post a comment carrying our proposal marker. A maintainer's `go`
 * then fed that body to a live `--yolo` run as the approved plan — no write
 * access needed, just a workflow, and plenty of repositories run one on a
 * fork's pull request.
 *
 * Fails CLOSED: with no login to compare against, nothing is ours. The worst
 * case is proposing again; the alternative is running someone else's text.
 */
export const isOurs = (comment, us) => Boolean(us) && comment?.user?.type === "Bot" && comment?.user?.login === us

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

/**
 * How many failing tests the report names before it stops — FR-28.
 *
 * A suite that loses a hundred tests turns the check into a wall of text
 * nobody reads. The first few plus a count is more useful than all of them,
 * and every one is still annotated on the diff.
 */
const FAILURES_LISTED = 20

/**
 * Make text that came from outside safe to put in our own comment.
 *
 * The answer and the failing-test names are the only parts of the comment
 * this Action did not write: agent prose quoting build logs and repository
 * files, and test names out of the run's report. On a fork's pull request all
 * of it is attacker-influenceable, and even without malice a log line can
 * happen to contain one of our markers.
 *
 * Markers are how a later run finds this comment and how a proposal's state
 * is tracked, and they are HTML comments — so one arriving inside borrowed
 * text is read back as our own control data.
 *
 * Only the OPENING delimiter needs breaking; without it `-->` is three
 * characters of prose. `&lt;!--` still reads as `<!--` once GitHub renders
 * it, so a quoted log line is not altered for the person reading it. Breaking
 * the syntax rather than the words also means a legitimate explanation that
 * mentions a marker by name still says what it meant to say.
 *
 * Idempotent: the output contains no `<!--` for a second pass to find.
 */
function inertMarkers(text) {
	return String(text).replace(/<!--/g, "&lt;!--")
}

/** The failing tests, named, with where they are when that is known. */
function failureLines(failedTests) {
	const failures = failedTests ?? []
	if (failures.length === 0) return []

	const lines = ["**Failed:**", ""]
	for (const t of failures.slice(0, FAILURES_LISTED)) {
		// A number or nothing: `line` is borrowed from the same report as the
		// rest and went in raw, which neutralising its two siblings had missed.
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
	askedBy,
	askedAt,
	approvedPlan,
	workNote,
	extraChecks = [],
	warnings = [],
} = {}) {
	const lines = []
	// The mark goes in front of the words, never instead of them: a reader with
	// images off, or a screen reader, still gets the whole outcome.
	lines.push(`## Test Companion — ${withMark(outcome)}`)
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
		["Outcome", withMark(outcome)],
		["Took", summary.duration],
		// Credits, not dollars: it is the unit the bill and the pipeline file's
		// own ceiling are written in, so a figure in dollars would not line up
		// with the limit the run was given.
		["Cost", summary.credits ? `${summary.credits} credits` : ""],
		["CLI", cliVersion],
		// Which request this is the answer to. The comment is edited in place,
		// so without this a reader cannot tell whose question it answers.
		["Asked by", askedBy ? (askedAt ? `[@${askedBy}](${askedAt})` : `@${askedBy}`) : ""],
		// WHICH plan this run carried out. With two plans waiting on one commit,
		// "approved" on its own does not say which was approved — and after
		// item 5 two CAN wait, because approving one no longer finishes off the
		// other.
		["Plan", approvedPlan?.url ? `[#${approvedPlan.id}](${approvedPlan.url})` : ""],
	].filter(([, v]) => v)

	lines.push("| | |", "|---|---|")
	for (const [k, v] of rows) lines.push(`| ${k} | ${inertMarkers(v)} |`)
	lines.push("")

	// For `rca` and `verdict` this IS the report — they produce no artefact, only
	// an explanation. It goes directly under the table, above the run links,
	// because it is the thing the person who commented actually asked for.
	// Everything else leaves the view untouched: no answer, nothing rendered.
	if (String(answer ?? "").trim()) {
		lines.push(inertMarkers(String(answer).trim()), "")
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
		lines.push(`**Why it stopped:** \`${inertMarkers(summary.error_type)}\``, "")
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

/**
 * The longest body GitHub will accept on an issue comment.
 *
 * Over this the API rejects the call outright, so the run reports NOTHING —
 * no table, no answer, no link. Worse than the missing answer that reading
 * every job's closing words set out to fix (STM-5434).
 */
export const COMMENT_LIMIT = 65536

/** Where the whole thing can still be read when the comment could not hold it. */
function cutShortNote(runUrl) {
	const where = runUrl ? `the [run page](${runUrl})` : "the run's summary"
	return `\n\n_Cut short to fit a comment. The full version is on ${where}._`
}

/**
 * The pull request comment — the same content, plus the marker.
 *
 * The answer is the one field with no natural bound: `generate` describing
 * thirty test cases runs to tens of thousands of characters. It is cut before
 * anything else, because the table, the links and the marker are what make the
 * comment work at all — and the marker in particular is how the next run finds
 * this comment to edit. Lose it and every run posts a new one (FR-29).
 */
export function renderComment(args) {
	const tail = `\n\n${COMMENT_MARKER}`
	const body = renderJobSummary(args)
	if (body.length + tail.length <= COMMENT_LIMIT) return body + tail

	const note = cutShortNote(args?.runUrl)
	const answer = inertMarkers(String(args?.answer ?? "").trim())
	if (answer) {
		// Measure the rest by rendering it with a one-character answer, so this
		// stays exact if the layout around it ever changes.
		const overhead = renderJobSummary({ ...args, answer: "x" }).length - 1
		const room = COMMENT_LIMIT - overhead - tail.length - note.length
		if (room > 0) {
			// Back up to a line break where there is one nearby: cutting inside
			// a code fence leaves it unterminated and the rest of the comment
			// renders as code.
			const cut = answer.slice(0, room)
			const nl = cut.lastIndexOf("\n")
			const kept = nl > room / 2 ? cut.slice(0, nl) : cut
			return renderJobSummary({ ...args, answer: kept + note }) + tail
		}
	}
	// Over the limit with no answer at all — a run with thousands of failing
	// tests does this. Trim the rendered body itself; the marker still goes on.
	const rest = renderJobSummary({ ...args, answer: undefined })
	return rest.slice(0, Math.max(0, COMMENT_LIMIT - tail.length - note.length)) + note + tail
}

/**
 * Edit our comment, or write the first one.
 *
 * Only a comment WE wrote counts. Matching on the marker alone would let a
 * person quoting our comment in their reply capture the thread, after which
 * every run would overwrite their words.
 */
export function chooseCommentAction(comments, us) {
	const ours = (comments ?? []).filter((c) => isOurs(c, us) && (c.body ?? "").includes(COMMENT_MARKER))
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

/**
 * What to say to somebody who asked us to stop — STM-5434 demo feedback,
 * item 7.
 *
 * `stop` used to cancel the run in flight and drop the waiting plan. Both are
 * gone, so this answers both halves: GitHub cancels a run, and a plan nobody
 * answers expires by itself. Saying only the first would leave someone
 * wondering what became of the plan they were trying to drop.
 */
export function renderStopRemoved() {
	return [
		"`stop` is no longer something I do.",
		"",
		"To end a run that is going, use **Cancel workflow** on the run's own page — GitHub does that more reliably than I could.",
		"",
		"To get rid of a plan waiting for approval, just leave it. It expires on its own after 24 hours and the check resolves with it.",
	].join("\n")
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
 * ONE LITERAL pattern, with the sha captured rather than interpolated.
 *
 * It used to be built per-search from the sha, which meant the sha had to be
 * regex-escaped or it would quietly match OTHER commits — `a.c*d+` also finds
 * `abcccd`, so a plan for one commit could be approved against another. The
 * escaping was correct, but it was a rule every caller had to remember.
 *
 * Comparing captured text with `===` removes the rule instead of restating
 * it: there is nothing to escape, nothing to get wrong, and no pattern built
 * from input (which is also what Semgrep was pointing at —
 * browserstack/github-actions#91, findings 9 and 12).
 */
const MARKER = /<!-- test-companion-proposal sha=([^\s>]+)(?: by=([^\s>]+))?(?: workflow=([^\s>]+))? -->/

/** The marker's fields, or undefined when the comment has none. */
const readMarker = (body) => {
	const found = MARKER.exec(String(body ?? ""))
	return found ? { sha: found[1], requester: found[2], workflow: found[3] } : undefined
}

/**
 * The commit a check we already posted belongs to — review of #3101, B1.
 *
 * The "in progress" check goes up BEFORE the CLI runs, so the run can be
 * cancelled while it is going, and it is posted on the PULL REQUEST's head. Anything
 * that finishes the run afterwards has to complete THAT check, on THAT
 * commit. Reaching for the event's own sha instead is wrong on a comment run,
 * where GITHUB_SHA is the default branch's commit: the second check lands on
 * main and the pull request's one stays pending for ever.
 */
export function checkSubjectFor(made, fallbackSha) {
	for (const sha of made?.keys?.() ?? []) return sha
	return fallbackSha
}

/** The proposal comment: what the run would do, and how to let it — FR-43. */
export function renderProposal(body, sha, requester, workflow) {
	return [
		body,
		"",
		"Reply **go** to run this for real. Nothing is written until you do. To change the list first, reply **@test-companion go** with your edits. Leave it and it expires on its own after a day.",
		"",
		proposalMarkerFor(sha, requester, workflow),
	].join("\n")
}

/**
 * Has the plan for THIS commit already been used, and how?
 *
 * Found by the live run that verified the consumed marker. A second `go` was
 * correctly not re-run, but the reply said "that plan was for an earlier
 * commit" — because with nothing waiting the caller reaches for a superseded
 * proposal, and an older one from before the branch moved was still in the
 * thread. The commit had not changed; the plan had been approved and run.
 *
 * Returns "approved" or "dropped" so the reply can say which, or undefined
 * when the plan on this commit has not been used at all and the superseded
 * reading is the right one after all.
 */
export function proposalAlreadyUsed(comments, sha, us, workflow) {
	const want = String(sha ?? "").trim()
	const job = String(workflow ?? "").trim()
	// No job asked about means "any plan on this commit", which is what the
	// caller wants when the reply named no job either.
	const here = spentPlans(comments, us).filter((m) => m.sha === want && (!m.workflow || !job || m.workflow === job))
	if (here.some((m) => m.kind === "consumed")) return "approved"
	if (here.some((m) => m.kind === "dropped")) return "dropped"
	return undefined
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
export function findProposal(comments, sha, now = Date.now(), us, opts = {}) {
	// `by=` and `workflow=` are both optional, so proposals written before
	// either was recorded stay approvable rather than becoming stuck.
	const want = String(sha ?? "").trim()
	// Spent, either way round: approved and run (M5), or dropped by `stop` or
	// by the sweep. Checked before anything else, so neither a second `go` nor
	// the sweep can act on a plan that is already finished with.
	//
	// PER JOB, not per commit (STM-5434 demo feedback, item 5). A plan a
	// marker does not name is still waiting, however many OTHER plans on this
	// commit have been used up.
	const spent = spentPlans(comments, us).filter((m) => m.sha === want)
	if (spent.some((m) => !m.workflow)) return undefined
	const spentJobs = new Set(spent.map((m) => m.workflow))

	let ours = (comments ?? []).filter((c) => isOurs(c, us) && readMarker(c.body)?.sha === want)
	ours = ours.filter((c) => !spentJobs.has(readMarker(c.body)?.workflow ?? ""))
	// `go #1234` names ONE plan. With two waiting there is otherwise nothing in
	// what was typed that picks between them, and the newest wins by default —
	// fine when there is one, a coin toss when there are two.
	const named = String(opts?.id ?? "").trim()
	if (named) ours = ours.filter((c) => String(c.id) === named)
	if (ours.length === 0) return undefined
	const newest = ours.reduce((a, b) => (a.id >= b.id ? a : b))
	const age = now - Date.parse(newest.created_at ?? "")
	const mark = readMarker(newest.body)
	return {
		id: newest.id,
		// So the run's own comment can link the plan it carried out.
		url: newest.html_url,
		expired: !(age <= PROPOSAL_WINDOW_MS),
		requester: mark?.requester,
		// The job the person actually read and approved. Undefined on a
		// proposal written before the marker carried one.
		workflow: mark?.workflow,
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
/**
 * A proposal has been APPROVED and run — review of #3101, M5.
 *
 * Approving left no trace, so the proposal stayed "waiting" after it had
 * already been carried out: a second `go` ran the job again, and a day later
 * the sweep told the person their approved plan had gone unanswered.
 *
 * Separate from the dropped marker because they are different events and the
 * reply text differs, but both mean the same thing here — this plan is spent.
 */
export function proposalConsumedMarkerFor(sha, workflow) {
	return `<!-- test-companion-proposal-consumed sha=${String(sha ?? "")}${jobField(workflow)} -->`
}

export function proposalDroppedMarkerFor(sha, workflow) {
	return `<!-- test-companion-proposal-dropped sha=${String(sha ?? "")}${jobField(workflow)} -->`
}

/**
 * The JOB travels with a spent plan too — STM-5434 demo feedback, item 5.
 *
 * Keyed on the commit alone, one approval finished off every plan on that
 * commit: approving `fix` meant a waiting `generate` plan could not be
 * approved at all until somebody pushed. Hit twice during testing.
 */
function jobField(workflow) {
	const job = String(workflow ?? "").trim()
	return job ? ` workflow=${job}` : ""
}

/**
 * Every record in this thread of a plan being finished with, and what for.
 *
 * ONE pattern, matching both kinds, for the same reason MARKER is one pattern:
 * the readers drifted twice when there were several.
 *
 * `workflow=` is absent on markers written before the job was recorded. Those
 * mean the whole commit — which is what they meant when they were written.
 * Reading them as "no particular job" would let an upgrade re-run work
 * somebody had already approved, so they keep their old, wider meaning.
 */
const SPENT_MARKER = /<!-- test-companion-proposal-(consumed|dropped) sha=([^\s>]+)(?: workflow=([^\s>]+))? -->/g

function spentPlans(comments, us) {
	const out = []
	for (const c of comments ?? []) {
		if (!isOurs(c, us)) continue
		for (const m of String(c.body ?? "").matchAll(SPENT_MARKER)) {
			out.push({ kind: m[1], sha: m[2], workflow: m[3] })
		}
	}
	return out
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
export function proposalNeedsDropping(comments, sha, now = Date.now(), us) {
	// findProposal already leaves out anything dropped or approved, per job, so
	// an expired plan coming back from it is by definition one nobody has
	// finished with. The separate dropped-marker check this used to do was the
	// same question asked twice, and the second asking was commit-wide — which
	// is exactly what item 5 had to stop.
	return Boolean(findProposal(comments, sha, now, us)?.expired)
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
	// The answer is now caught off the run's own output and rendered in the
	// summary above, for every job. For the verbs whose result file holds that
	// SAME closing text — `test-pr` proposing is one — appending it here
	// printed the whole explanation twice (live run 41457337090). Compared on
	// squashed whitespace, because the two copies travel by different routes
	// and need not agree on line breaks.
	const squash = (t) =>
		String(t ?? "")
			.replace(/\s+/g, " ")
			.trim()
	const alreadyAbove = body !== "" && squash(summary).includes(squash(body))
	// Only `test-pr` writes a separate plan file. For every other job the
	// proposal run is a PREVIEW run — it does the work and writes nothing —
	// so its report above IS what is being approved. Saying "there is nothing
	// here to approve" told the reader to re-run something that had worked.
	const noPlan = String(summary ?? "").trim()
		? "_The report above is what this run would do. Nothing has been written._"
		: "_This run did not produce a plan — there is nothing here to approve. The run log will say why; re-run once that is fixed._"
	parts.push(alreadyAbove ? noPlan : body || noPlan)
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
export function findSupersededProposal(comments, sha, us) {
	const current = String(sha ?? "").trim()
	// Same reader as findProposal, so the two cannot drift again.
	const stale = (comments ?? []).filter((c) => {
		if (!isOurs(c, us)) return false
		const found = readMarker(c.body)
		return Boolean(found) && found.sha !== current
	})
	if (stale.length === 0) return undefined
	// Newest wins: with several old plans, the one they most plausibly meant is
	// the last one we put up.
	const newest = stale.reduce((a, b) => ((a.id ?? 0) >= (b.id ?? 0) ? a : b))
	const found = readMarker(newest.body)
	return { sha: found?.sha, requester: found?.requester, id: newest.id }
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
