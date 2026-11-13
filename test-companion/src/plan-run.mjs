import { isApprovalOnly } from "./intent.mjs"
/**
 * Turn a GitHub event into a `tc workflow run` invocation. The CLI reads no
 * GITHUB_* variables itself, so all its context comes from here.
 */

/** Event names pipeline files bind to. Public: add names, never rename them. */
export const TC_EVENTS = Object.freeze({
	PR_COMMENT: "pr_comment",
	PR_OPENED: "pr_opened",
	PR_UPDATED: "pr_updated",
	PR_MERGED: "pr_merged",
	PUSH: "push",
	BUILD_FAILED: "build_failed",
	SCHEDULE: "schedule",
})

/**
 * `@browserstack` as a whole word. Not an email, `@browserstack/team`,
 * `@browserstack-x`, `@browserstack[bot]` or `@browserstack.com`; a trailing
 * full stop still counts.
 */
const MENTION = /(^|[^\w.+@-])@browserstack(?![\w\-/[]|\.\w)/i
const MENTIONS = new RegExp(MENTION.source, "gi")

// Refuse a value that could be read as a flag (CWE-88).
const looksLikeAFlag = (v) => typeof v === "string" && v.trimStart().startsWith("-")

const skip = (reason, detail) => ({ skip: { reason, detail } })

/** Context keys the CLI reads. Anything else is dropped. */
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
	"ticket",
	"plan_file",
	"focus",
	"propose_only",
])

// A `,` or `=` in user text could inject extra context keys (e.g. `sha=`),
// and pflag's CSV parsing rejects a bare `"`.
const stripSeparators = (v) => String(v).replace(/[,="]/g, " ").replace(/\s+/g, " ").trim()

/**
 * Add the pull request's head commit to a comment-triggered plan;
 * `issue_comment` carries none. A missing or foreign head repo is a fork.
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

/** One `--context` flag per pair, which keeps pflag off its CSV parser. */
export function contextArgs(context = {}) {
	return Object.entries(context).flatMap(([k, v]) => ["--context", `${k}=${v}`])
}

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
 * Decide what this event should run: `{skip}` or
 * `{event?, workflow?, preview?, context}`. No event means ignore the bindings.
 */
export function planRun({ eventName, payload = {}, inputs = {}, repo, sha, ref } = {}) {
	const built = route({ eventName, payload, inputs, repo, sha, ref })
	if (built.skip) return built

	// A named job wins on any trigger and bypasses the bindings.
	const named = (inputs.workflow ?? "").trim()
	if (named && !built.workflow) {
		built.workflow = named
		built.preview = built.preview || String(inputs.preview ?? "") === "true"
		delete built.event
	}

	// Clean before checking for flags: the check must see what the CLI sees.
	const context = cleanContext(built.context ?? {})

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
			return skip("unsupported-event", eventName)
	}
}

function fromComment(payload, inputs) {
	if (payload.action !== "created") return skip("comment-edited", payload.action)
	if (!payload.issue?.pull_request) return skip("not-a-pull-request")
	// Our own comments quote "@browserstack go"; reacting to them loops and can push a real request out of the queue.
	const author = payload.comment?.user
	if (author?.type === "Bot" || /\[bot\]$/i.test(author?.login ?? "")) return skip("bot-comment", author?.login)

	const body = payload.comment?.body ?? ""
	const addressed = MENTION.test(body)

	// A bare approval ("go", optionally with a plan reference) needs no mention.
	// Anything more must address us, so a review comment never starts a run.
	const approvalOnly = !addressed && isApprovalOnly(body)
	if (!addressed && !approvalOnly) return skip("not-addressed-to-us")

	// Strip the mention; `$1` restores the character the match consumed.
	const instructions = body.replace(MENTIONS, "$1").replace(/\s+/g, " ").trim()

	return {
		event: TC_EVENTS.PR_COMMENT,
		context: {
			pr: String(payload.issue.number),
			instructions,
			actor: payload.comment?.user?.login,
		},
		requiresWriteAccess: true,
		commenter: payload.comment?.user?.login,
		askedAt: payload.comment?.html_url,
		approvalOnly,
	}
}

function fromPullRequest(payload, repo) {
	const p = payload.pull_request ?? {}

	// Refuse forks. Fails closed: `pull_request_target` has secrets even for a
	// fork, and `head.repo` is null once a fork is deleted.
	const head = p.head?.repo?.full_name
	if (!repo || !head || head.toLowerCase() !== repo.toLowerCase()) {
		return skip("fork", head ?? "unknown-origin")
	}

	if (payload.action === "closed") {
		if (!p.merged) return skip("closed-unmerged")
		return {
			event: TC_EVENTS.PR_MERGED,
			context: {
				// The merge commit is what landed.
				sha: p.merge_commit_sha ?? p.head?.sha,
				branch: p.base?.ref,
				pr: String(p.number),
			},
		}
	}

	// A comment can still start a run on a draft.
	if (p.draft) return skip("draft")

	const event = payload.action === "opened" || payload.action === "reopened" ? TC_EVENTS.PR_OPENED : TC_EVENTS.PR_UPDATED

	if (payload.action !== "opened" && payload.action !== "reopened" && payload.action !== "synchronize") {
		return skip("unsupported-event", `pull_request.${payload.action}`)
	}

	return {
		event,
		// No `subject`: without one the CLI scopes the run to this commit's diff.
		context: { sha: p.head?.sha, branch: p.head?.ref, pr: String(p.number) },
	}
}

function fromWorkflowRun(payload, inputs, repo) {
	const run = payload.workflow_run ?? {}
	if (payload.action !== "completed") return skip("unsupported-event", `workflow_run.${payload.action}`)

	// workflow_run has full secrets even for a fork's run. Fails closed.
	const head = run.head_repository?.full_name
	if (!repo || !head || head.toLowerCase() !== repo.toLowerCase()) {
		return skip("fork", head ?? "unknown-origin")
	}

	// Never react to our own failed run, or it loops.
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
		// No event, so the CLI ignores the pipeline bindings.
		workflow,
		preview: String(inputs.preview ?? "") === "true",
		context: { sha, branch: branchFromRef(ref) },
	}
}

const branchFromRef = (ref) => (typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : undefined)
