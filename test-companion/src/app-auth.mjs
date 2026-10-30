/**
 * Signing in as the Test Companion GitHub App — STM-5434 Release 4.
 *
 * Release 4 buys exactly three things, and this is what makes the first two
 * real: the comment and the tick come from "Test Companion" rather than
 * github-actions[bot], and the team can delete the permissions block from
 * their workflow file because an installation token carries the App's own
 * permissions.
 *
 * It does not run anything. A run still happens on the customer's machine
 * with their BrowserStack credentials; this only changes who GitHub thinks is
 * talking.
 *
 * Zero dependencies, like the rest of the Action: Node's crypto signs the JWT
 * and `gh` exchanges it. The private key never leaves this process, and never
 * reaches the agent's environment — childEnvFor is an allowlist and these
 * names are not on it.
 */
import { createSign } from "node:crypto"

/** base64url, which is what JWT uses — base64 with three characters swapped. */
const b64url = (input) => Buffer.from(input).toString("base64url")

/**
 * The App's credentials, or nothing.
 *
 * Both halves are required: an App id with no key cannot sign, and a key with
 * no id cannot say who it is. Either alone means the workflow is half
 * configured, and falling back to the workflow token is the right answer —
 * silently, because a repository that never set this up is the normal case.
 */
export function appCredentials(env = {}) {
	const appId = String(env.TC_ACTION_APP_ID ?? "").trim()
	const privateKey = String(env.TC_ACTION_APP_PRIVATE_KEY ?? "").trim()
	if (!appId || !privateKey) return undefined
	return { appId, privateKey }
}

/** How long a JWT lives. GitHub refuses anything over ten minutes. */
const JWT_LIFETIME_SECONDS = 540

/**
 * The claims GitHub expects on an App JWT.
 *
 * `iat` is backdated a minute on purpose. GitHub rejects a token whose issued-at
 * is in the future, runner clocks drift, and the failure reads "issued at is in
 * the future" on an otherwise perfectly configured workflow. Backdating is the
 * documented workaround.
 */
export function jwtClaims(appId, nowSeconds) {
	const iat = Math.floor(nowSeconds) - 60
	return { iat, exp: iat + JWT_LIFETIME_SECONDS, iss: String(appId) }
}

/** A signed App JWT. RS256 is the only algorithm GitHub accepts here. */
export function signJwt({ appId, privateKey, now = Date.now() / 1000 }) {
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
	const payload = b64url(JSON.stringify(jwtClaims(appId, now)))
	const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey, "base64url")
	return `${header}.${payload}.${signature}`
}

/**
 * What to ask for when minting an installation token — FR-4.
 *
 * FR-4 says the Action uses the App's identity "for that repo only". A token
 * minted with no body does the opposite: it carries every permission the
 * installation holds across every repository it covers, so a run in one
 * repository would hold write access to all of an organisation's.
 *
 * The permissions are the four the starter workflow asks for, and the four
 * this Action actually uses:
 *   contents      — branches and commits for the fix and reconcile jobs
 *   pull_requests — the one comment, and opening a pull request
 *   checks        — the "Test Companion" check
 *   actions       — reading the red run, and cancelling one on "stop"
 *
 * Returns undefined for a repository we cannot parse. Falling back to an
 * unscoped request would be the worst possible reading of a value we did not
 * understand.
 */
export function installationTokenRequest(repo) {
	const parts = String(repo ?? "").split("/")
	if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined
	return {
		// Bare names: the API rejects "owner/name" here as not found, which
		// would silently fall back to the workflow token.
		repositories: [parts[1]],
		permissions: {
			contents: "write",
			pull_requests: "write",
			checks: "write",
			actions: "write",
		},
	}
}
