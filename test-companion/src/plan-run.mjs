import { isApprovalOnly } from "./intent.mjs"
/**
 * Turn a GitHub event into a `tc workflow run` invocation.
 *
 * The CLI deliberately refuses to read GITHUB_* variables itself, so that the
 * same CLI behaves identically on Jenkins. Every piece of context it gets
 * comes from here.
 *
 * Pure — payload in, plan out, no I/O — because the only other way to test it
 * is to push a commit and wait for a runner.
 *
 * ── The event vocabulary is a public contract ───────────────────────────────
 * `--event` is free text to the CLI, matched against whatever the customer
 * wrote in their pipeline file's `on:` field. The names below ARE the API:
 * renaming one silently stops matching every pipeline that used it, with no
 * error — the binding just never fires. Add names; do not rename them.
 */

/** Every event name a pipeline file may bind to. */
export const TC_EVENTS = Object.freeze({
	PR_COMMENT: "pr_comment",
	PR_OPENED: "pr_opened",
	PR_UPDATED: "pr_updated",
	PR_MERGED: "pr_merged",
	PUSH: "push",
	BUILD_FAILED: "build_failed",
	SCHEDULE: "schedule",
})

/** How a run is addressed in a comment. */
const MENTION = "@test-companion"

/**
 * The CLI rejects a context value that begins with `-` (CWE-88), and a pull
 * request title or comment body is attacker-controlled on a public repo. Catch
 * it here so it is refused before it reaches a command line, not after.
 */
const looksLikeAFlag = (v) => typeof v === "string" && v.trimStart().startsWith("-")

const skip = (reason, detail) => ({ skip: { reason, detail } })

/**
 * Every context key the CLI actually reads. An allowlist rather than a
 * denylist: a key it does not know is silently ignored, so passing one is at
 * best noise and at worst a way to smuggle something past review.
 */
const ALLOWED_CONTEXT_KEYS = new Set([
	"sha",
	"branch",
	"paths",
	"build_status",
	"pr",
	"subject",
	"url",
	"build",
	"description",
	"target",
	"cases",
	"app",
	"task",
	"instructions",
	"actor",
	// the ticket this change is for, found in the branch, title or body.
	"ticket",
	// the approved plan this run must carry out, written by the Action.
	"plan_file",
	// how large the change is, when it is too big to cover in one go.
	"focus",
	// this run is the gate's planning pass — plan, do not write.
	"propose_only",
])

/**
 * `--context` is a comma-separated `k=v` list, so a value containing `,` or
 * `=` can append keys of its own — "@test-companion go,sha=deadbeef" would
 * redirect the run at another commit. Comments and titles are
 * attacker-controlled on a public repo, so the separators are removed rather
 * than escaped: readable prose matters more than its punctuation.
 *
 * `"` is here because pflag parses a multi-pair --context value as CSV, which
 * rejects a bare quote — a PR titled `Fix "Pay now" button` failed flag
 * parsing outright. contextArgs below is the real fix; this is the belt.
 */
const stripSeparators = (v) => String(v).replace(/[,="]/g, " ").replace(/\s+/g, " ").trim()

/**
 * Fill a comment-triggered plan in with the pull request's own head commit.
 *
 * `issue_comment` carries the issue number and nothing about the code: no
 * sha, no branch, and `GITHUB_SHA` is the DEFAULT BRANCH tip for that event.
 * Without this the run reads main and its check lands on main's latest
 * commit.
 *
 * Fails CLOSED. A head repository that is missing, or not ours, is treated as
 * a fork and skipped — a comment is an untrusted trigger.
 *
 * `pr` is the API's pull request object; `repo` is "owner/name" for this
 * repository. A plan that already names a commit is returned untouched.
 */
export function withPullRequestHead(plan, pr, repo) {
	if (plan?.context?.sha) {
		return plan
	}
	const sha = pr?.head?.sha
	const ref = pr?.head?.ref
	if (!sha || !ref) {
		return { ...plan, skip: "no-pr-head" }
	}
	const from = pr?.head?.repo?.full_name
	if (!repo || !from || from.toLowerCase() !== repo.toLowerCase()) {
		return { ...plan, skip: "fork" }
	}
	return { ...plan, context: { ...plan.context, sha, branch: ref } }
}

/**
 * The --context flags for one plan, ONE FLAG PER PAIR.
 *
 * Joining pairs into a single `--context a=1,b=2` sends pflag down its CSV
 * path, where one double quote anywhere fails the whole flag. A value with
 * exactly one `=` takes the single-pair path instead, which never parses CSV.
 */
export function contextArgs(context = {}) {
	return Object.entries(context).flatMap(([k, v]) => ["--context", `${k}=${v}`])
}

/** Drop empty values rather than passing `k=` through to the CLI. */
function cleanContext(pairs) {
	const out = {}
	for (const [k, v] of Object.entries(pairs)) {
		if (v === undefined || v === null) continue
		if (!ALLOWED_CONTEXT_KEYS.has(k)) continue
		const s = stripSeparators(v)
		if (s !== "") out[k] = s
	}
	return out
}

/**
 * Decide what, if anything, this event should run.
 *
 * Returns either `{skip: {reason}}` — a clean no-op the step reports and passes
 * or `{event?, workflow?, preview?, context}`. A manual run carries NO event,
 * which is how the CLI is told to ignore the pipeline bindings.
 */
export function planRun({ eventName, payload = {}, inputs = {}, repo, sha, ref } = {}) {
	const built = route({ eventName, payload, inputs, repo, sha, ref })
	if (built.skip) return built

	// An explicitly named job wins on any trigger, not only a manual one.
	// Explicit beats implicit, and naming a job is how the bindings are
	// bypassed — same as a manual run, so the event is dropped with it.
	const named = (inputs.workflow ?? "").trim()
	if (named && !built.workflow) {
		built.workflow = named
		built.preview = built.preview || String(inputs.preview ?? "") === "true"
		delete built.event
	}

	// Clean FIRST, then gate — the order matters and was the wrong way round.
	// cleanContext calls stripSeparators, which turns `,`, `=` and `"` into
	// spaces and trims. Checking the raw value let `",--config /x"` look safe
	// and come out as `--config /x`, while the same text unwrapped was
	// correctly refused. The gate has to see what the CLI will see.
	const context = cleanContext(built.context ?? {})

	// One gate for every path, so a new trigger cannot forget it.
	for (const [k, v] of Object.entries(context)) {
		if (looksLikeAFlag(v)) return skip("unsafe-context", `${k} starts with "-"`)
	}
	return { ...built, context }
}

function route({ eventName, payload, inputs, repo, sha, ref }) {
	switch (eventName) {
		case "issue_comment":
			return fromComment(payload, inputs)
		case "pull_request":
		case "pull_request_target":
			return fromPullRequest(payload, repo)
		case "workflow_run":
			return fromWorkflowRun(payload, inputs, repo)
		case "push":
			return {
				event: TC_EVENTS.PUSH,
				context: { sha: payload.after, branch: branchFromRef(payload.ref) },
			}
		case "schedule":
			return { event: TC_EVENTS.SCHEDULE, context: { sha, branch: branchFromRef(ref) } }
		case "workflow_dispatch":
			return fromManual(inputs, sha, ref)
		default:
			// Better a clean skip than a guess: an unrecognised event with invented
			// context would run the wrong job against the wrong commit.
			return skip("unsupported-event", eventName)
	}
}

function fromComment(payload, inputs) {
	// an edit must not start a run, or correcting a typo in an old comment
	// re-runs the job.
	if (payload.action !== "created") return skip("comment-edited", payload.action)
	// GitHub delivers pull request comments as issue_comment; only the presence
	// of `pull_request` distinguishes them from real issues.
	if (!payload.issue?.pull_request) return skip("not-a-pull-request")

	const body = payload.comment?.body ?? ""
	const addressed = body.toLowerCase().includes(MENTION)

	// A bare approval needs no mention: the proposal says "Reply go to run
	// this for real", and people do exactly that.
	//
	// EXACTLY the approval and nothing else. Merely opening with the word is
	// too wide — "Approved, but rename the login case" is an ordinary review
	// comment, and it would start a live write run with the rest carried in
	// as approver edits. Edits alongside an approval are still supported, but
	// then the person has to address us.
	//
	// A plan reference may follow the word and nothing else: `go #<id>` or
	// `go <comment link>`, which is how you say WHICH plan when two are
	// waiting. Six digits at least, and it must be the whole rest of the
	// comment, so "go and look at #25 too" still needs the mention.
	const approvalOnly = !addressed && isApprovalOnly(body)
	if (!addressed && !approvalOnly) return skip("not-addressed-to-us")

	// Everything after the mention is what the person actually asked for. The
	// mention itself is addressing, not instruction, so it is stripped.
	const instructions = body.replace(new RegExp(MENTION, "ig"), "").replace(/\s+/g, " ").trim()

	return {
		event: TC_EVENTS.PR_COMMENT,
		context: {
			pr: String(payload.issue.number),
			instructions,
			// The commenter is who the run is attributed to and whose permission
			// the caller checks before this plan is acted on.
			actor: payload.comment?.user?.login,
		},
		requiresWriteAccess: true,
		commenter: payload.comment?.user?.login,
		// Where the request was made. One comment edited in place cannot
		// otherwise say WHICH request it is answering, and on a busy pull
		// request that is most of the question.
		askedAt: payload.comment?.html_url,
		// Carried so main.mjs can refuse it when no proposal is waiting.
		approvalOnly,
	}
}

function fromPullRequest(payload, repo) {
	const p = payload.pull_request ?? {}

	// A fork's workflow gets a read-only token and no secrets, so a run would
	// fail partway with a confusing permissions error. Refuse up front.
	//
	// Fails CLOSED, which matters most for `pull_request_target`: that trigger
	// runs in the BASE repository's context WITH secrets even for a fork's
	// pull request, so this check is the only thing in front of it.
	//
	// GitHub sets `head.repo` to null when the fork has been DELETED, so a
	// missing repo must refuse too — otherwise opening a pull request from a
	// fork and then deleting it runs attacker-authored code with our
	// credentials and --yolo.
	//
	// Compared case-insensitively, because GitHub treats repository names
	// that way.
	const head = p.head?.repo?.full_name
	if (!repo || !head || head.toLowerCase() !== repo.toLowerCase()) {
		return skip("fork", head ?? "unknown-origin")
	}

	if (payload.action === "closed") {
		if (!p.merged) return skip("closed-unmerged")
		return {
			event: TC_EVENTS.PR_MERGED,
			context: {
				// The merge commit is what landed; the head sha is a branch that may
				// no longer exist. Scoping to head would examine code never merged.
				sha: p.merge_commit_sha ?? p.head?.sha,
				branch: p.base?.ref,
				pr: String(p.number),
			},
		}
	}

	// a draft never starts a run by itself. A comment still can, which is
	// why this sits here rather than in the comment path.
	if (p.draft) return skip("draft")

	const event = payload.action === "opened" || payload.action === "reopened" ? TC_EVENTS.PR_OPENED : TC_EVENTS.PR_UPDATED

	if (payload.action !== "opened" && payload.action !== "reopened" && payload.action !== "synchronize") {
		// labelled, assigned, review_requested and friends are noise here.
		return skip("unsupported-event", `pull_request.${payload.action}`)
	}

	return {
		event,
		// No `subject` on purpose. generateSubject in the CLI builds the
		// commit-scoped prompt — "the change in PR #N, commit SHA … covering only
		// what that change touches" — ONLY when no subject is given. Sending the
		// title made `generate` write cases for the title rather than the diff,
		// which is the opposite of.
		context: { sha: p.head?.sha, branch: p.head?.ref, pr: String(p.number) },
	}
}

function fromWorkflowRun(payload, inputs, repo) {
	const run = payload.workflow_run ?? {}
	if (payload.action !== "completed") return skip("unsupported-event", `workflow_run.${payload.action}`)

	// workflow_run is a PRIVILEGED trigger: it runs in the base repository's
	// context with full secrets even when the run it reacts to came from a fork.
	// The fork check in the pull_request path does not cover it, and missing
	// this is the documented way these workflows get compromised.
	// Fails CLOSED: an absent or unmatched head repository is treated as a fork.
	// For a trigger that carries full secrets, "cannot confirm it is ours" has
	// to mean no.
	const head = run.head_repository?.full_name
	if (!repo || !head || head.toLowerCase() !== repo.toLowerCase()) {
		return skip("fork", head ?? "unknown-origin")
	}

	// never explain our own red run, or a failing Test Companion check
	// triggers a run to explain the failing Test Companion check, forever.
	const self = inputs["self-workflow-name"]
	if (self && run.name === self) return skip("own-run", run.name)

	if (run.conclusion !== "failure") return skip("build-not-red", run.conclusion)

	return {
		event: TC_EVENTS.BUILD_FAILED,
		context: {
			build: run.html_url,
			sha: run.head_sha,
			branch: run.head_branch,
			build_status: "failed",
			pr: run.pull_requests?.[0]?.number ? String(run.pull_requests[0].number) : undefined,
		},
	}
}

function fromManual(inputs, sha, ref) {
	const workflow = (inputs.workflow ?? "").trim()
	if (!workflow) return skip("no-workflow-named", "workflow_dispatch needs a `workflow` input")
	return {
		// Deliberately no event: that is how the CLI is told to ignore the
		// pipeline bindings and run exactly what was asked for.
		workflow,
		preview: String(inputs.preview ?? "") === "true",
		context: { sha, branch: branchFromRef(ref) },
	}
}

const branchFromRef = (ref) => (typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : undefined)
