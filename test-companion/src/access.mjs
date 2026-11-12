/**
 * Write access is always required: a run executes an agent on the runner.
 * `askTeam` can only narrow that. `inTeam` undefined (lookup failed) counts as no.
 */
export function mayAsk({ hasWriteAccess, askTeam, inTeam } = {}) {
	if (!hasWriteAccess) return false
	if (!String(askTeam ?? "").trim()) return true
	return inTeam === true
}

/**
 * The comment to mark with 👀 once a request is picked up, or undefined. Only a comment a
 * person with access wrote to us: never a bot's, never a refused one, and a bare `go` only
 * when there is a plan for it to approve.
 */
export function pickupReactionTarget({ eventName, comment, plan, allowed, approvalHasPlan } = {}) {
	if (eventName !== "issue_comment" || !plan || plan.skip || plan.event !== "pr_comment") return undefined
	if (allowed !== true) return undefined
	const author = comment?.user
	if (!author || author.type === "Bot" || /\[bot\]$/i.test(author.login ?? "")) return undefined
	if (plan.approvalOnly && approvalHasPlan !== true) return undefined
	const id = Number(comment?.id)
	return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/**
 * Add 👀 to a comment. Best-effort: `post(path, body)` is the API call; any failure,
 * thrown or returned, is reported back and never stops the run. Returns true when added.
 */
export function addPickupReaction({ repo, commentId, post }) {
	if (!repo || !commentId || typeof post !== "function") return false
	try {
		return post(`repos/${repo}/issues/comments/${commentId}/reactions`, { content: "eyes" }) === true
	} catch {
		return false
	}
}

/** Whether this run can write to the configured tests repository. `canPush` undefined counts as no. */
export function describeTestRepoAccess({ testsRepo, thisRepo, canPush } = {}) {
	const target = String(testsRepo ?? "").trim()
	if (!target) return { ok: true }
	if (target.toLowerCase() === String(thisRepo ?? "").toLowerCase()) return { ok: true }
	if (canPush === true) return { ok: true }

	return {
		ok: false,
		message:
			`Test code is configured to go to \`${target}\`, but this run cannot write there, so nothing was written to it. ` +
			`Install the Test Companion GitHub App on both repositories, or add a token with write access to \`${target}\` as a secret.`,
	}
}
