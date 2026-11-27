/**
 * Signing in as the BrowserStack GitHub App without holding its key.
 *
 * The job asks GitHub for a short-lived identity token (OIDC) that says which
 * repository and run it is, addressed to BrowserStack's token service. The
 * service checks it and returns an App token limited to this one repository.
 * The App's key never leaves the service. Any failure falls back to the
 * workflow token, as a job without the App does today.
 */
import { retryDelayMs } from "./app-auth.mjs"

export const DEFAULT_BROKER_URL = "https://test-companion.browserstack.com/api/github-app/token"
/** Who the identity token is addressed to; the service refuses any other. */
export const OIDC_AUDIENCE = "test-companion.browserstack.com"
/** The App's slug, so its bot account is `<slug>[bot]`. */
export const DEFAULT_APP_SLUG = "browserstack"
/** One call gives up after this long; a timeout counts as a network error, so it is retried. */
export const BROKER_CALL_TIMEOUT_MS = 10_000

/** The service's address, or undefined with why: only an https URL with no credentials in it is used. */
export function brokerUrlFrom(input) {
	const raw = String(input ?? "").trim() || DEFAULT_BROKER_URL
	let url
	try {
		url = new URL(raw)
	} catch {
		return { reason: "token-broker-url is not a valid URL" }
	}
	if (url.protocol !== "https:") return { reason: "token-broker-url must use https" }
	if (url.username || url.password) return { reason: "token-broker-url must not contain credentials" }
	return { url: url.toString() }
}

/** The App's slug from the input, or the default. Only a GitHub-shaped slug is used. */
export function appSlugFrom(input) {
	const slug = String(input ?? "").trim().toLowerCase()
	return /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug) ? slug : DEFAULT_APP_SLUG
}

/**
 * Where to ask GitHub for the identity token, or undefined when this job can't:
 * GitHub only sets these two when the job has `permissions: id-token: write`.
 */
export function oidcRequestFrom(env = {}) {
	const requestUrl = String(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "").trim()
	const requestToken = String(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "").trim()
	if (!requestUrl || !requestToken) return undefined
	return { requestUrl, requestToken }
}

/** The identity-token request URL with our audience; GitHub's URL already carries a query. */
export function oidcUrlFor(requestUrl, audience = OIDC_AUDIENCE) {
	const url = new URL(requestUrl)
	url.searchParams.set("audience", audience)
	return url.toString()
}

/** A network failure, a 429 or a 5xx may pass on another try; 503 means "turned off" and won't. */
export function isBrokerRetryable(status) {
	const s = Number(status)
	return s === 0 || s === 429 || (s >= 500 && s <= 599 && s !== 503)
}

/** The one-line notice for falling back to the workflow token. Never contains a token. */
export function brokerFallbackNotice(result) {
	const status = Number(result?.status)
	if (status === 404) return "Test Companion: the BrowserStack GitHub App isn't installed on this repository; using the workflow token."
	if (status === 503) return "Test Companion: App sign-in is turned off; using the workflow token."
	const why = result?.reason || (Number.isFinite(status) && status > 0 ? `HTTP ${status}` : "no reply")
	return `Test Companion: could not sign in as the GitHub App (${why}); using the workflow token.`
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One JSON call with a time limit and retries. Returns { ok, status, data, reason, attempts }; never throws. */
async function callJson(url, init, { fetchImpl = fetch, attempts = 3, sleep = defaultSleep, timeoutMs = BROKER_CALL_TIMEOUT_MS } = {}) {
	let result
	for (let attempt = 1; attempt <= attempts; attempt++) {
		result = await callOnce(url, init, { fetchImpl, timeoutMs })
		if (result.ok || !isBrokerRetryable(result.status) || attempt === attempts) return { ...result, attempts: attempt }
		await sleep(retryDelayMs(result, attempt))
	}
	return { ...result, attempts }
}

async function callOnce(url, init, { fetchImpl, timeoutMs }) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new Error(`no reply within ${timeoutMs / 1000}s`)), timeoutMs)
	try {
		let response
		try {
			response = await fetchImpl(url, { ...init, signal: controller.signal })
		} catch (e) {
			return { ok: false, status: 0, data: undefined, reason: `could not reach it: ${e?.message ?? e}` }
		}
		const data = await response.json().catch(() => undefined)
		const retryAfter = response.headers?.get?.("retry-after") ?? undefined
		return {
			ok: response.ok,
			status: response.status,
			data,
			reason: response.ok ? "" : `HTTP ${response.status}`,
			...(retryAfter ? { retryAfter } : {}),
		}
	} finally {
		clearTimeout(timer)
	}
}

/** Ask GitHub for this job's identity token. Returns { ok, value } or { ok: false, status, reason }. */
export async function requestOidcToken({ requestUrl, requestToken, audience = OIDC_AUDIENCE, ...opts }) {
	const r = await callJson(oidcUrlFor(requestUrl, audience), { method: "GET", headers: { Authorization: `bearer ${requestToken}` } }, opts)
	const value = r.ok ? r.data?.value : undefined
	if (typeof value !== "string" || !value) {
		return { ok: false, status: r.status, reason: r.ok ? "GitHub returned no identity token" : `identity token: ${r.reason}` }
	}
	return { ok: true, value }
}

/** Trade the identity token for an App token. Returns the service's reply as { ok, status, data, reason }. */
export async function requestBrokerToken({ url, oidcToken, ...opts }) {
	return callJson(
		url,
		{ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ oidc_token: oidcToken }) },
		opts,
	)
}

/**
 * The whole exchange. Returns { token, oidcToken } on success, or { notice } to fall back with.
 * `mask` is called with each credential the moment it is received, before anything else uses it.
 * The service's token must be for this job's repository; any other is refused.
 */
export async function appTokenFromBroker({ env = {}, mask = () => {}, ...opts } = {}) {
	const request = oidcRequestFrom(env)
	if (!request) {
		return {
			notice:
				"Test Companion: posting as github-actions[bot]. To post as BrowserStack, install the BrowserStack GitHub App " +
				"and add `id-token: write` to this job's permissions.",
		}
	}
	const target = brokerUrlFrom(env.TC_ACTION_TOKEN_BROKER_URL)
	if (!target.url) return { notice: `Test Companion: ${target.reason}; using the workflow token.` }

	const oidc = await requestOidcToken({ ...request, ...opts })
	if (!oidc.ok) return { notice: brokerFallbackNotice({ status: oidc.status, reason: oidc.reason }) }
	mask(oidc.value)

	const got = await requestBrokerToken({ url: target.url, oidcToken: oidc.value, ...opts })
	const token = got.ok ? got.data?.token : undefined
	if (token) mask(token)
	if (!got.ok) return { notice: brokerFallbackNotice(got), attempts: got.attempts }
	if (typeof token !== "string" || !token) return { notice: brokerFallbackNotice({ reason: "the reply had no token" }) }

	const repo = String(env.GITHUB_REPOSITORY ?? "").toLowerCase()
	const issuedFor = String(got.data?.repository ?? "").toLowerCase()
	if (!repo || issuedFor !== repo) {
		return { notice: brokerFallbackNotice({ reason: "the token was issued for a different repository" }) }
	}
	return { token, oidcToken: oidc.value, attempts: got.attempts }
}
