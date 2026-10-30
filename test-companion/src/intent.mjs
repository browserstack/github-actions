/**
 * What did the comment ask for? — STM-5434 FR-34.
 *
 * A person writes "@test-companion fix the failing tests" and something has to
 * turn that sentence into a job name. That happens HERE, in the Action, before
 * the CLI is spawned, for one reason: FR-34 says a request we cannot place gets
 * a reply listing what we can do, and "nothing SHALL run". Handing the sentence
 * to the agent and letting it work out what was meant would spend the
 * customer's credits discovering that "make coffee" was never a job.
 *
 * Kept pure — text in, intent out, no I/O — like plan-run.mjs beside it, so the
 * whole vocabulary is testable in milliseconds instead of a push-and-wait loop.
 *
 * The phrasing people use is NOT a closed set, and this will never match
 * everything. That is why UNKNOWN is a real answer rather than a failure: an
 * unmatched comment gets the list of what Test Companion can do, which is both
 * the honest reply and the cheapest one.
 */

/** What a comment turned out to be asking for. */
export const INTENT = Object.freeze({
	/** Run a Test Companion job. `workflow` names it, or is null for "whatever is bound". */
	WORKFLOW: "workflow",
	/** Cancel the run in flight — FR-35. */
	STOP: "stop",
	/** Approve a waiting proposal, which starts the real run — FR-43. */
	GO: "go",
	/** Open the pull request that adds a starter pipeline file — FR-13. */
	SETUP: "setup",
	/** We could not place it. FR-34: reply with the list, run nothing. */
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
 * Cancel the run in flight — FR-35. Still checked before any job word, so
 * "stop, don't fix anything" cannot start a fix run.
 *
 * ANCHORED, because matching the word anywhere made "don't stop until the
 * tests pass" cancel the run. What the comment opens with is what it is
 * asking for; the same word later in a sentence is usually about something
 * else.
 */
const STOP = /^stop\b/i

/**
 * FR-13: "set up this repo" opens the pull request that adds the starter file.
 * Anchored for the same reason — "the test setup is broken, fix it" was
 * opening a settings pull request instead of running fix.
 */
const SETUP = /^set\s?-?\s?up\b/i

/** FR-8: "Any comment MAY ask for a single preview run." A modifier, not a job. */
const PREVIEW = /\bpreview\b/i

/** Run the bound jobs again on this commit — which is what a re-check is. */
const RECHECK = /\bre-?\s?check\b/i

/**
 * Approve a waiting proposal — FR-43.
 *
 * Tested AFTER the job words, deliberately. "go" is two letters and turns up
 * inside ordinary instructions, so a sentence that names a job is read as
 * asking for that job; only a reply naming none is an approval. `\bgo\b` does
 * not match "going", which is the case that would otherwise bite.
 */
const GO = /\b(go|approved?)\b/i

/**
 * Plain words to job names, most specific first.
 *
 * The names on the right are the CLI's, not the PRD's — `tc workflow run` only
 * accepts what is in registry.go's builtinNames, so "explain" has to become
 * `rca` and "find the bad PR" has to become `verdict` here or the run fails
 * with "unknown workflow". That translation is the whole point of this table.
 */
const PHRASES = [
	// Before the `fix` rule: "find the bad PR" shares no word with it, but
	// keeping the multi-word jobs first means a later single-word rule can never
	// steal one of them.
	[/\bfind\s+(the\s+)?bad\s+(pr|prs|pull requests?)\b/i, ["verdict"]],
	// Each phrase maps to a PREFERENCE LIST: the first one this repository has
	// actually bound wins, and the first overall is the fallback.
	//
	// "test this PR" is why the list exists. It used to map to `test`, which
	// runs a project's EXISTING suite and never reads the diff — the very
	// behaviour test-pr was built to replace. A repository still bound to the
	// older job keeps working; one that has moved gets the job that reads the
	// change. (Found by the first live run, rag_assignment PR #20.)
	[/\btest\s+(this\s+)?(pr|pull request|change|diff)\b/i, ["test-pr", "test"]],
	[/\bexplain\b/i, ["rca"]],
	[/\bfix\b/i, ["fix"]],
]

/** The first candidate this repository has bound, or the first overall. */
const pickBound = (candidates, workflows) => candidates.find((c) => (workflows ?? []).includes(c)) ?? candidates[0]


/**
 * A job asked for by its own name — FR-34.
 *
 * PHRASES covers the wording the PRD lists, which is four of the CLI's
 * fourteen jobs. FR-34 asks for "any BOUND workflow in plain words", and
 * naming a job IS plain words, so the names the repository has actually bound
 * are matched literally as a fallback.
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
 * This replaced a regex built per name from the name itself. The regex was
 * escaped and safe, but a pattern assembled from input is a pattern someone
 * can get wrong later, and Semgrep flagged it twice
 * (browserstack/github-actions#91, findings 8 and 12). Comparing words needs
 * no escaping at all.
 *
 * One deliberate difference: punctuation inside a name is now a word break,
 * so a job called `a.c` is also found in the words "a c". Names come from the
 * repository's own pipeline file and are ordinary words in practice, and
 * being slightly more willing to recognise one is the safe direction — the
 * alternative is telling someone their own job name is not a job.
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

	// Before the job words: FR-35 gives stop its own 30-second deadline, and
	// "stop, don't fix anything" must not start a fix run.
	const asked = text.replace(POLITENESS, "")
	if (STOP.test(asked)) return { kind: INTENT.STOP }
	if (SETUP.test(asked)) return { kind: INTENT.SETUP }

	const preview = PREVIEW.test(text)

	// With a plan waiting, an approval is what a reply most likely IS — and
	// FR-43 invites edits alongside it ("you can edit the list first"). Job
	// words match anywhere, so testing them first read "go, and fix case 3's
	// title" as a fresh request for `fix` and quietly dropped the approval
	// (M4, review of #3101). Still after STOP: approving and cancelling in one
	// breath has to cancel.
	if (proposalWaiting && GO.test(text)) return { kind: INTENT.GO }

	for (const [pattern, candidates] of PHRASES) {
		if (pattern.test(text)) {
			return { kind: INTENT.WORKFLOW, workflow: pickBound(candidates, workflows), preview }
		}
	}

	// A bound job asked for by its own name.
	const named = namedWorkflow(text, workflows)
	if (named) return { kind: INTENT.WORKFLOW, workflow: named, preview }

	// FR-43: a reply of "go", with or without edits to the case list.
	if (GO.test(text)) return { kind: INTENT.GO }

	// No job named, but a clear ask: run whatever the pipeline file binds to this
	// event — the same thing an event-driven run does — and carry the preview
	// flag if they asked for one.
	if (preview || RECHECK.test(text)) {
		return { kind: INTENT.WORKFLOW, workflow: null, preview }
	}
	return { kind: INTENT.UNKNOWN }
}

/**
 * What to offer when we could not place a request — FR-34.
 *
 * Deliberately only what actually works today. The PRD also names reconcile and
 * "automate the backlog", and neither exists as a `tc` job yet; listing them
 * would invite a request we would then have to refuse a second time.
 *
 * Kept next to PHRASES on purpose: a phrase people can type and a phrase we
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
	{ ask: "stop", does: "cancel the run in flight" },
])
