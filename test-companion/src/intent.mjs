/**
 * Maps a comment to a job before the CLI starts, so an unrecognised request
 * costs no agent run. UNKNOWN replies with the list of what we can do.
 */

export const INTENT = Object.freeze({
	/** `workflow` is null for "whatever is bound". */
	WORKFLOW: "workflow",
	/** No longer stops anything; still answered with what to do instead. */
	STOP: "stop",
	GO: "go",
	SETUP: "setup",
	UNKNOWN: "unknown",
})

/** Drop `>` quote-reply lines, which would otherwise match before the person's own words. */
const withoutQuotes = (text) =>
	text
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n")

const POLITENESS = /^(?:please\s+|pls\s+|can\s+you\s+|could\s+you\s+|kindly\s+)+/i

// STOP, SETUP and GO are anchored to the start: "don't stop until the tests
// pass" or "the test setup is broken" must not match.
const STOP = /^stop\b/i

const SETUP = /^set\s?-?\s?up\b/i

const PREVIEW = /\bpreview\b/i

const RECHECK = /\bre-?\s?check\b/i

// "don't go ahead yet" must not approve; "go, and fix case 3's title" should.
const GO = /^(?:go|approved?)\b/i

/** Shared with plan-run.mjs and report.mjs, which must agree on it. */
export const BARE_APPROVAL = /^\s*(?:go|approved?)\s*[.!]*\s*$/i

/** `go #<id>` or `go <comment link>`. Six digits minimum so `#25` (a PR) is not read as a plan. */
export const APPROVAL_WITH_PLAN = /^\s*(?:go|approved?)\s+\S*#(?:issuecomment-)?(\d{6,})\s*[.!]*\s*$/i

export const isApprovalOnly = (text) => BARE_APPROVAL.test(String(text ?? "")) || APPROVAL_WITH_PLAN.test(String(text ?? ""))

const namedProposal = (text) => APPROVAL_WITH_PLAN.exec(String(text ?? ""))?.[1]

/** Phrases to CLI job names, most specific first; the first job the repo has bound wins. */
const PHRASES = [
	[/\bfind\s+(the\s+)?bad\s+(pr|prs|pull requests?)\b/i, ["verdict"]],
	// Falls back to `test` for repositories still bound to it.
	[/\btest\s+(this\s+)?(pr|pull request|change|diff)\b/i, ["test-pr", "test"]],
	[/\bexplain\b/i, ["rca"]],
	[/\bfix\b/i, ["fix"]],
]

const pickBound = (candidates, workflows) => candidates.find((c) => (workflows ?? []).includes(c)) ?? candidates[0]

/** A bound job named literally, longest first so "mobile run" is not read as "run". */
function namedWorkflow(text, workflows) {
	const said = wordsOf(text)
	const byLength = [...(workflows ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)
	return byLength.find((name) => saysAll(said, wordsOf(name)))
}

// Underscore is a word character, so `test_pr` is not read as `test-pr`.
const wordsOf = (text) =>
	String(text ?? "")
		.toLowerCase()
		.match(/[a-z0-9_]+/g) ?? []

const saysAll = (said, name) => name.length > 0 && said.some((_, i) => name.every((w, j) => said[i + j] === w))

/** `instructions` is the comment with the @mention already stripped. */
export function readIntent(instructions, { workflows = [], proposalWaiting = false } = {}) {
	const text = withoutQuotes(String(instructions ?? "")).trim()
	if (!text) return { kind: INTENT.UNKNOWN }

	// Before job words, so "stop, don't fix anything" cannot start a fix.
	const asked = text.replace(POLITENESS, "")
	if (STOP.test(asked)) return { kind: INTENT.STOP }
	if (SETUP.test(asked)) return { kind: INTENT.SETUP }

	const preview = PREVIEW.test(text)

	// Before job words, so "go, and fix case 3's title" stays an approval.
	if (proposalWaiting && GO.test(asked)) return { kind: INTENT.GO, proposalId: namedProposal(text) }

	for (const [pattern, candidates] of PHRASES) {
		if (pattern.test(text)) {
			return { kind: INTENT.WORKFLOW, workflow: pickBound(candidates, workflows), preview }
		}
	}

	const named = namedWorkflow(text, workflows)
	if (named) return { kind: INTENT.WORKFLOW, workflow: named, preview }

	if (GO.test(asked)) return { kind: INTENT.GO, proposalId: namedProposal(text) }

	// No job named: run whatever is bound to this event.
	if (preview || RECHECK.test(text)) {
		return { kind: INTENT.WORKFLOW, workflow: null, preview }
	}
	return { kind: INTENT.UNKNOWN }
}

/** Keep in step with PHRASES. */
export const CAPABILITIES = Object.freeze([
	{ ask: "test this PR", does: "write and run tests for this change" },
	{ ask: "explain this failure", does: "say why a red build failed, test by test" },
	{ ask: "fix the failing tests", does: "fix stale tests and open a pull request with them" },
	{ ask: "find the bad PR", does: "say which recent change most likely broke a red build" },
	{ ask: "set up this repo", does: "open a pull request adding a settings file" },
	{ ask: "preview", does: "do the run but write nothing — add it to any request above" },
	{ ask: "re-check", does: "run it again on the latest commit" },
])
