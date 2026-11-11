/**
 * Write access is always required: a run executes an agent on the runner.
 * `askTeam` can only narrow that. `inTeam` undefined (lookup failed) counts as no.
 */
export function mayAsk({ hasWriteAccess, askTeam, inTeam } = {}) {
	if (!hasWriteAccess) return false
	if (!String(askTeam ?? "").trim()) return true
	return inTeam === true
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
