/**
 * What did the comment ask for?
 *
 * "@browserstack fix the failing tests" becomes a job name here, in the
 * Action, before the CLI is spawned. Handing the sentence to the agent
 * instead would spend the customer's credits discovering that "make coffee"
 * was never a job.
 *
 * Pure — text in, intent out, no I/O — so the whole vocabulary is testable in
 * milliseconds.
 *
 * The phrasing people use is not a closed set, so UNKNOWN is a real answer
 * rather than a failure: an unmatched comment gets the list of what Test
 * Companion can do.
 */

/** What a comment turned out to be asking for. */
export const INTENT = Object.freeze({
	/** Run a Test Companion job. `workflow` names it, or is null for "whatever is bound". */
	WORKFLOW: "workflow",
	/** Asked us to stop. Nothing stops any more — item 7 — but the word is still answered. */
	STOP: "stop",
	/** Approve a waiting proposal, which starts the real run. */
	GO: "go",
	/** Open the pull request that adds a starter pipeline file. */
	SETUP: "setup",
	/** We could not place it: reply with the list, run nothing. */
	UNKNOWN: "unknown",
})

/**
 * GitHub's "Quote reply" button copies the comment being replied to in as `>`
 * lines, mention and all. Without dropping those first, replying to Test
 * Companion's own "comment stop to cancel" message would cancel the run: the
 * quoted words match before the person's own ever get read.
 */
const withoutQuotes = (text) =>
	text
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n")

/**
 * A leading politeness, which says nothing about what is being asked for.
 * "please stop" is a stop; dropping it lets the patterns below anchor.
 */
const POLITENESS = /^(?:please\s+|pls\s+|can\s+you\s+|could\s+you\s+|kindly\s+)+/i

/**
 * Checked before any job word, so "stop, don't fix anything" cannot start a
 * fix run.
 *
 * ANCHORED, because matching the word anywhere made "don't stop until the
 * tests pass" cancel the run. What the comment opens with is what it is
 * asking for; the same word later in a sentence is usually about something
 * else.
 */
/**
 * STILL RECOGNISED, but it no longer does anything.
 *
 * Proposals already sitting in live threads tell people to say it, and
 * answering those with "that did not name anything I can do" would be true and
 * useless. main.mjs says what to do instead.
 */
const STOP = /^stop\b/i

/**
 * "set up this repo" opens the pull request that adds the starter file.
 * Anchored for the same reason — "the test setup is broken, fix it" was
 * opening a settings pull request instead of running fix.
 */
const SETUP = /^set\s?-?\s?up\b/i

/** "Any comment MAY ask for a single preview run." A modifier, not a job. */
const PREVIEW = /\bpreview\b/i

/** Run the bound jobs again on this commit — which is what a re-check is. */
const RECHECK = /\bre-?\s?check\b/i

/**
 * Approve a waiting proposal.
 *
 * Tested AFTER the job words, deliberately. "go" is two letters and turns up
 * inside ordinary instructions, so a sentence that names a job is read as
 * asking for that job; only a reply naming none is an approval. `\bgo\b` does
 * not match "going", which is the case that would otherwise bite.
 */
const GO = /\b(go|approved?)\b/i

/**
 * An approval and nothing else.
 *
 * ONE definition, exported, because three readers have to agree on it: this
 * file (does the reply name a plan?), plan-run.mjs (may an UNADDRESSED
 * comment reach us at all?) and report.mjs (did the approver edit the plan?).
 * Each past disagreement between them was a bug.
 */
export const BARE_APPROVAL = /^\s*(?:go|approved?)\s*[.!]*\s*$/i

/**
 * An approval that names WHICH plan — `go #<id>`, or `go <comment link>`.
 *
 * ANCHORED to the approval word and to the end of the comment. Matching a
 * `#id` anywhere would turn "go — and pull the steps from
 * <url>#issuecomment-…" into an approval of a plan that does not exist.
 *
 * Six digits at least: a GitHub comment id is ten digits, and `#25` is
 * somebody pointing at a pull request.
 */
export const APPROVAL_WITH_PLAN = /^\s*(?:go|approved?)\s+\S*#(?:issuecomment-)?(\d{6,})\s*[.!]*\s*$/i

/** Is this reply an approval and nothing else, with or without a plan named? */
export const isApprovalOnly = (text) => BARE_APPROVAL.test(String(text ?? "")) || APPROVAL_WITH_PLAN.test(String(text ?? ""))

/**
 * WHICH plan a reply is approving.
 *
 * `go #<id>`, or the comment link GitHub gives you when you copy a comment's
 * address. A bare `go` names nothing and the newest waiting plan wins, which
 * is right when there is one and a coin toss when there are two.
 */
const namedProposal = (text) => APPROVAL_WITH_PLAN.exec(String(text ?? ""))?.[1]

/**
 * Plain words to job names, most specific first.
 *
 * The names on the right are the CLI's: `tc workflow run` only accepts its
 * own registered jobs, so "explain" has to become `rca` and "find the bad PR"
 * has to become `verdict` here, or the run fails with "unknown workflow".
 */
const PHRASES = [
	// Before the `fix` rule: "find the bad PR" shares no word with it, but
	// keeping the multi-word jobs first means a later single-word rule can never
	// steal one of them.
	[/\bfind\s+(the\s+)?bad\s+(pr|prs|pull requests?)\b/i, ["verdict"]],
	// Each phrase maps to a PREFERENCE LIST: the first one this repository has
	// actually bound wins, and the first overall is the fallback.
	//
	// "test this PR" is why the list exists. `test` runs a project's EXISTING
	// suite and never reads the diff, which is what test-pr replaced. A
	// repository still bound to the older job keeps working; one that has
	// moved gets the job that reads the change.
	[/\btest\s+(this\s+)?(pr|pull request|change|diff)\b/i, ["test-pr", "test"]],
	[/\bexplain\b/i, ["rca"]],
	[/\bfix\b/i, ["fix"]],
]

/** The first candidate this repository has bound, or the first overall. */
const pickBound = (candidates, workflows) => candidates.find((c) => (workflows ?? []).includes(c)) ?? candidates[0]

/**
 * A job asked for by its own name.
 *
 * PHRASES covers four of the CLI's fourteen jobs, so the names a repository
 * has actually bound are matched literally as a fallback.
 *
 * Longest first, so "mobile run" is never read as "run". Word boundaries, so
 * "regenerated the lockfile" is not a request to run `generate`.
 */
function namedWorkflow(text, workflows) {
	const said = wordsOf(text)
	const byLength = [...(workflows ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)
	return byLength.find((name) => saysAll(said, wordsOf(name)))
}

/**
 * The words in a string, lowercased.
 *
 * Underscore counts as part of a word, matching what `\b` does, so `test_pr`
 * is one word and is not read as the job `test-pr`.
 */
const wordsOf = (text) =>
	String(text ?? "")
		.toLowerCase()
		.match(/[a-z0-9_]+/g) ?? []

/**
 * Does `said` contain `name` as a consecutive run of WHOLE words?
 *
 * Word comparison rather than a regex built from the name, so there is
 * nothing to escape.
 *
 * One consequence: punctuation inside a name is a word break, so a job called
 * `a.c` is also found in the words "a c". Names come from the repository's own
 * pipeline file, and being slightly more willing to recognise one is the safe
 * direction — the alternative is telling someone their own job name is not a
 * job.
 */
const saysAll = (said, name) => name.length > 0 && said.some((_, i) => name.every((w, j) => said[i + j] === w))

/**
 * Read a comment's instruction — the body with the @mention already stripped by
 * plan-run.mjs — and say what it asked for.
 *
 * `workflows` is what the repository has bound, so a job can be asked for by
 * name. Without it, only the written-out phrases are understood.
 */
export function readIntent(instructions, { workflows = [], proposalWaiting = false } = {}) {
	const text = withoutQuotes(String(instructions ?? "")).trim()
	if (!text) return { kind: INTENT.UNKNOWN }

	// Before the job words, so "stop, don't fix anything" cannot start a fix
	// run. It no longer stops anything; it answers with what to use instead.
	const asked = text.replace(POLITENESS, "")
	if (STOP.test(asked)) return { kind: INTENT.STOP }
	if (SETUP.test(asked)) return { kind: INTENT.SETUP }

	const preview = PREVIEW.test(text)

	// With a plan waiting, a reply most likely IS an approval — and edits
	// alongside it are invited ("you can edit the list first"). Job words
	// match anywhere, so testing them first would read "go, and fix case 3's
	// title" as a fresh request for `fix` and drop the approval. Still after
	// STOP: approving and cancelling in one breath has to cancel.
	if (proposalWaiting && GO.test(text)) return { kind: INTENT.GO, proposalId: namedProposal(text) }

	for (const [pattern, candidates] of PHRASES) {
		if (pattern.test(text)) {
			return { kind: INTENT.WORKFLOW, workflow: pickBound(candidates, workflows), preview }
		}
	}

	// A bound job asked for by its own name.
	const named = namedWorkflow(text, workflows)
	if (named) return { kind: INTENT.WORKFLOW, workflow: named, preview }

	// a reply of "go", with or without edits to the case list.
	if (GO.test(text)) return { kind: INTENT.GO, proposalId: namedProposal(text) }

	// No job named, but a clear ask: run whatever the pipeline file binds to this
	// event — the same thing an event-driven run does — and carry the preview
	// flag if they asked for one.
	if (preview || RECHECK.test(text)) {
		return { kind: INTENT.WORKFLOW, workflow: null, preview }
	}
	return { kind: INTENT.UNKNOWN }
}

/**
 * What to offer when we could not place a request.
 *
 * Only what actually works today: advertising a job that does not exist
 * invites a request we would have to refuse a second time.
 *
 * Kept next to PHRASES on purpose — a phrase people can type and a phrase we
 * advertise should never drift apart.
 */
export const CAPABILITIES = Object.freeze([
	{ ask: "test this PR", does: "write and run tests for this change" },
	{ ask: "explain this failure", does: "say why a red build failed, test by test" },
	{ ask: "fix the failing tests", does: "fix stale tests and open a pull request with them" },
	{ ask: "find the bad PR", does: "say which recent change most likely broke a red build" },
	{ ask: "set up this repo", does: "open a pull request adding a settings file" },
	{ ask: "preview", does: "do the run but write nothing — add it to any request above" },
	{ ask: "re-check", does: "run it again on the latest commit" },
])
