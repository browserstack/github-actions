/**
 * Who may ask Test Companion for a run — STM-5434 FR-33.
 *
 * Write access is the floor and it is not negotiable. On a public repository
 * anyone can comment, and a run executes an agent with --yolo against the
 * customer's own machine and credentials, so this is the whole access-control
 * story for the comment trigger.
 *
 * The pipeline file may NARROW that to a named team. It may never widen it:
 * being on the team is not a way in for someone who cannot write to the
 * repository. That asymmetry is the requirement, and it is the reason this is a
 * function rather than two booleans combined at the call site.
 */

/**
 * `inTeam` is tri-state on purpose. `undefined` means we could not find out —
 * no token for the organisation, API down, rate limited — and an unanswerable
 * question is a no, matching hasWriteAccess itself.
 */
export function mayAsk({ hasWriteAccess, askTeam, inTeam } = {}) {
	if (!hasWriteAccess) return false
	if (!String(askTeam ?? "").trim()) return true
	return inTeam === true
}

/**
 * Can this run write test code where the settings say it should? — FR-42.
 *
 * Tests go in the pull request's own repository by default. A repository that
 * points somewhere else needs either the GitHub App installed on both, or a
 * token with write access stored as a secret.
 *
 * FR-42 asks for the summary to say WHICH is missing, and that wording is the
 * requirement: a bare "permission denied" halfway through a run leaves someone
 * guessing between the two, after the credits are already spent.
 *
 * `canPush` is tri-state. undefined means we could not find out, and an
 * unanswerable question is a no — the same rule as every other access check
 * here.
 */
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
