/**
 * Signing in as the GitHub App, so comments, checks and commits come from the
 * App rather than github-actions[bot]. The workflow token is the fallback.
 */
import { createSign } from "node:crypto"

const b64url = (input) => Buffer.from(input).toString("base64url")

/** The App's id and key, or undefined unless both are set. */
export function appCredentials(env = {}) {
	const appId = String(env.TC_ACTION_APP_ID ?? "").trim()
	const privateKey = String(env.TC_ACTION_APP_PRIVATE_KEY ?? "").trim()
	if (!appId || !privateKey) return undefined
	return { appId, privateKey }
}

// GitHub refuses a JWT that lives over ten minutes.
const JWT_LIFETIME_SECONDS = 540

/** `iat` is backdated a minute because runner clocks drift and GitHub rejects a future `iat`. */
export function jwtClaims(appId, nowSeconds) {
	const iat = Math.floor(nowSeconds) - 60
	return { iat, exp: iat + JWT_LIFETIME_SECONDS, iss: String(appId) }
}

/**
 * Call the GitHub API as the App. Not through gh: gh sends `Authorization: token`,
 * and GitHub accepts an App's JWT only as `Authorization: Bearer`.
 * Returns { ok, status, data, reason }; `reason` is GitHub's message, never the JWT.
 */
export async function appApi(path, { jwt, method = "GET", body, apiUrl, fetchImpl = fetch, attempts = 3, sleep = defaultSleep } = {}) {
	let result
	for (let attempt = 1; attempt <= attempts; attempt++) {
		result = await appApiOnce(path, { jwt, method, body, apiUrl, fetchImpl })
		if (!isRetryable(result) || attempt === attempts) return { ...result, attempts: attempt }
		await sleep(retryDelayMs(result, attempt))
	}
	return { ...result, attempts }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A network failure, a 5xx or a 429 may pass on a second try; 401/403/404/422 never will. */
export function isRetryable(result) {
	const status = Number(result?.status)
	return status === 0 || status === 429 || (status >= 500 && status <= 599)
}

/** 1s, then 3s; a Retry-After from GitHub wins, capped at 10s. */
export function retryDelayMs(result, attempt) {
	const after = Number(result?.retryAfter)
	if (Number.isFinite(after) && after > 0) return Math.min(after, 10) * 1000
	return attempt === 1 ? 1000 : 3000
}

async function appApiOnce(path, { jwt, method, body, apiUrl, fetchImpl }) {
	const base = String(apiUrl || "https://api.github.com").replace(/\/+$/, "")
	let response
	try {
		response = await fetchImpl(`${base}/${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	} catch (e) {
		return { ok: false, status: 0, data: undefined, reason: `could not reach GitHub: ${e?.message ?? e}` }
	}
	const data = await response.json().catch(() => undefined)
	const reason = response.ok ? "" : `${data?.message || response.statusText || "no detail from GitHub"} (HTTP ${response.status})`
	const retryAfter = response.headers?.get?.("retry-after") ?? undefined
	return { ok: response.ok, status: response.status, data, reason, ...(retryAfter ? { retryAfter } : {}) }
}

/** What to log when looking up the App's installation on this repository fails. */
export function installationLookupMessage(result) {
	const reason = result?.reason || "no detail from GitHub"
	if (result?.status === 404) {
		return { level: "notice", text: "Test Companion: the GitHub App is not installed on this repository; using the workflow token." }
	}
	return {
		level: "warning",
		text:
			`Test Companion: could not sign in as the GitHub App (${reason}); using the workflow token. ` +
			"Check that app-id is the App's numeric ID and app-private-key is a key generated for that App.",
	}
}

export function signJwt({ appId, privateKey, now = Date.now() / 1000 }) {
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
	const payload = b64url(JSON.stringify(jwtClaims(appId, now)))
	const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey, "base64url")
	return `${header}.${payload}.${signature}`
}

/**
 * Scope the installation token to this repository: without a body it covers
 * every repository the App is installed on.
 */
export function installationTokenRequest(repo) {
	const parts = String(repo ?? "").split("/")
	if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined
	return {
		// Bare name: the API rejects "owner/name" here.
		repositories: [parts[1]],
		permissions: {
			contents: "write",
			pull_requests: "write",
			checks: "write",
			actions: "write",
		},
	}
}
