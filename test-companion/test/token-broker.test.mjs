import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
	DEFAULT_BROKER_URL,
	OIDC_AUDIENCE,
	brokerUrlFrom,
	appSlugFrom,
	oidcRequestFrom,
	oidcUrlFor,
	isBrokerRetryable,
	brokerFallbackNotice,
	requestOidcToken,
	appTokenFromBroker,
} from "../src/token-broker.mjs"
import { childEnvFor } from "../src/child-env.mjs"

const REQUEST_URL = "https://pipelines.actions.githubusercontent.example/abc/idtoken?api-version=2.0"
const OIDC_ENV = {
	ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL,
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
	GITHUB_REPOSITORY: "acme/shop",
}

const reply = (status, body, headers = {}) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
	headers: { get: (k) => headers[k.toLowerCase()] },
})

/** A fetch that records calls and answers the identity-token request and the service in turn. */
function fakeFetch({ oidc = [reply(200, { value: "oidc-jwt" })], broker = [] } = {}) {
	const calls = []
	const fetchImpl = async (url, init) => {
		calls.push({ url, init })
		const queue = String(url).startsWith(REQUEST_URL.split("?")[0]) ? oidc : broker
		const next = queue.shift()
		if (next instanceof Error) throw next
		return next ?? reply(500, {})
	}
	return { calls, fetchImpl }
}

const noSleep = async () => {}

describe("the identity token request", () => {
	test("is addressed to the token service, keeping GitHub's own query", () => {
		const url = new URL(oidcUrlFor(REQUEST_URL))
		assert.equal(url.searchParams.get("audience"), OIDC_AUDIENCE)
		assert.equal(url.searchParams.get("api-version"), "2.0")
		assert.equal(OIDC_AUDIENCE, "test-companion.browserstack.com")
	})

	test("sends GitHub's request token as a bearer token and reads .value", async () => {
		const { calls, fetchImpl } = fakeFetch()
		const got = await requestOidcToken({ requestUrl: REQUEST_URL, requestToken: "request-token", fetchImpl, sleep: noSleep })
		assert.deepEqual(got, { ok: true, value: "oidc-jwt" })
		assert.equal(calls[0].init.method, "GET")
		assert.equal(calls[0].init.headers.Authorization, "bearer request-token")
	})

	test("is only possible with both of GitHub's variables (id-token: write)", () => {
		assert.ok(oidcRequestFrom(OIDC_ENV))
		assert.equal(oidcRequestFrom({ ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL }), undefined)
		assert.equal(oidcRequestFrom({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" }), undefined)
	})
})

describe("the service's address", () => {
	test("defaults to BrowserStack's token service", () => {
		assert.equal(brokerUrlFrom("").url, DEFAULT_BROKER_URL)
		assert.equal(brokerUrlFrom(undefined).url, DEFAULT_BROKER_URL)
	})

	test("must be https", () => {
		assert.match(brokerUrlFrom("http://test-companion.browserstack.com/api/github-app/token").reason, /https/)
		assert.ok(brokerUrlFrom("https://staging.example/api/github-app/token").url)
	})

	test("refuses nonsense and embedded credentials", () => {
		assert.ok(brokerUrlFrom("not a url").reason)
		assert.ok(brokerUrlFrom("https://user:pass@staging.example/x").reason)
	})
})

describe("the App's bot account", () => {
	test("is browserstack[bot] unless a test App is named", () => {
		assert.equal(appSlugFrom(""), "browserstack")
		assert.equal(appSlugFrom("tc-staging-app"), "tc-staging-app")
	})

	test("an odd slug can't be used to name another account", () => {
		assert.equal(appSlugFrom("evil[bot] x"), "browserstack")
		assert.equal(appSlugFrom("../x"), "browserstack")
	})
})

describe("appTokenFromBroker", () => {
	test("posts only the identity token, and uses the token it gets back", async () => {
		const { calls, fetchImpl } = fakeFetch({
			broker: [reply(200, { token: "ghs_app", expires_at: "2026-11-16T10:00:00Z", repository: "acme/shop" })],
		})
		const masked = []
		const got = await appTokenFromBroker({ env: OIDC_ENV, mask: (s) => masked.push(s), fetchImpl, sleep: noSleep })
		assert.equal(got.token, "ghs_app")
		const post = calls[1]
		assert.equal(post.url, DEFAULT_BROKER_URL)
		assert.equal(post.init.method, "POST")
		assert.deepEqual(JSON.parse(post.init.body), { oidc_token: "oidc-jwt" })
	})

	test("masks the identity token and the App token as soon as each arrives", async () => {
		const { fetchImpl } = fakeFetch({ broker: [reply(200, { token: "ghs_app", repository: "acme/shop" })] })
		const masked = []
		await appTokenFromBroker({ env: OIDC_ENV, mask: (s) => masked.push(s), fetchImpl, sleep: noSleep })
		assert.deepEqual(masked, ["oidc-jwt", "ghs_app"])
	})

	test("a test service is used when named", async () => {
		const { calls, fetchImpl } = fakeFetch({ broker: [reply(200, { token: "t", repository: "acme/shop" })] })
		const env = { ...OIDC_ENV, TC_ACTION_TOKEN_BROKER_URL: "https://staging.example/api/github-app/token" }
		await appTokenFromBroker({ env, fetchImpl, sleep: noSleep })
		assert.equal(calls[1].url, "https://staging.example/api/github-app/token")
	})

	test("without id-token: write it falls back without calling anything", async () => {
		const { calls, fetchImpl } = fakeFetch()
		const got = await appTokenFromBroker({ env: { GITHUB_REPOSITORY: "acme/shop" }, fetchImpl, sleep: noSleep })
		assert.equal(got.token, undefined)
		assert.match(got.notice, /id-token: write/)
		assert.equal(calls.length, 0)
	})

	test("an http service address is refused before anything is sent", async () => {
		const { calls, fetchImpl } = fakeFetch()
		const env = { ...OIDC_ENV, TC_ACTION_TOKEN_BROKER_URL: "http://staging.example/x" }
		const got = await appTokenFromBroker({ env, fetchImpl, sleep: noSleep })
		assert.equal(got.token, undefined)
		assert.match(got.notice, /https/)
		assert.equal(calls.length, 0)
	})

	for (const [status, body, expected] of [
		[404, { error: "app_not_installed" }, /isn't installed on this repository/],
		[503, { error: "disabled" }, /App sign-in is turned off/],
		[401, { error: "unauthorized" }, /could not sign in as the GitHub App \(HTTP 401\)/],
		[502, { error: "upstream" }, /could not sign in as the GitHub App \(HTTP 502\)/],
		[429, {}, /could not sign in as the GitHub App \(HTTP 429\)/],
	]) {
		test(`a ${status} falls back with the right notice`, async () => {
			const { fetchImpl } = fakeFetch({ broker: [reply(status, body), reply(status, body), reply(status, body)] })
			const got = await appTokenFromBroker({ env: OIDC_ENV, fetchImpl, sleep: noSleep })
			assert.equal(got.token, undefined)
			assert.match(got.notice, expected)
		})
	}

	test("no notice ever contains a token", async () => {
		const { fetchImpl } = fakeFetch({ broker: [reply(401, { error: "unauthorized", token: "ghs_leak" })] })
		const got = await appTokenFromBroker({ env: OIDC_ENV, fetchImpl, sleep: noSleep })
		assert.doesNotMatch(got.notice, /ghs_leak|oidc-jwt|request-token/)
	})

	test("a token issued for another repository is not used", async () => {
		const { fetchImpl } = fakeFetch({ broker: [reply(200, { token: "ghs_other", repository: "acme/other" })] })
		const masked = []
		const got = await appTokenFromBroker({ env: OIDC_ENV, mask: (s) => masked.push(s), fetchImpl, sleep: noSleep })
		assert.equal(got.token, undefined)
		assert.match(got.notice, /different repository/)
		// Still masked: it arrived in this job's memory.
		assert.ok(masked.includes("ghs_other"))
	})

	test("GitHub refusing the identity token falls back", async () => {
		const { fetchImpl } = fakeFetch({ oidc: [reply(403, { message: "no" })] })
		const got = await appTokenFromBroker({ env: OIDC_ENV, fetchImpl, sleep: noSleep })
		assert.equal(got.token, undefined)
		assert.match(got.notice, /could not sign in as the GitHub App/)
	})

	test("a network failure is retried, then succeeds", async () => {
		const { calls, fetchImpl } = fakeFetch({
			broker: [new Error("socket hang up"), reply(500, {}), reply(200, { token: "ghs_app", repository: "acme/shop" })],
		})
		const got = await appTokenFromBroker({ env: OIDC_ENV, fetchImpl, sleep: noSleep })
		assert.equal(got.token, "ghs_app")
		assert.equal(got.attempts, 3)
		assert.equal(calls.length, 4)
	})

	test("gives up after three tries", async () => {
		const { calls, fetchImpl } = fakeFetch({ broker: [reply(502, {}), reply(502, {}), reply(502, {}), reply(200, { token: "late" })] })
		const got = await appTokenFromBroker({ env: OIDC_ENV, fetchImpl, sleep: noSleep })
		assert.equal(got.token, undefined)
		assert.equal(calls.length, 4) // one identity-token call, three to the service
	})

	for (const status of [401, 403, 404, 422, 503]) {
		test(`a ${status} is not retried`, async () => {
			const { calls, fetchImpl } = fakeFetch({ broker: [reply(status, {}), reply(200, { token: "t", repository: "acme/shop" })] })
			await appTokenFromBroker({ env: OIDC_ENV, fetchImpl, sleep: noSleep })
			assert.equal(calls.length, 2)
		})
	}

	test("a stalled call is cut off by the time limit and retried", async () => {
		let n = 0
		const fetchImpl = async (url, init) => {
			if (String(url).startsWith(REQUEST_URL.split("?")[0])) return reply(200, { value: "oidc-jwt" })
			n++
			if (n === 1) {
				return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))
			}
			return reply(200, { token: "ghs_app", repository: "acme/shop" })
		}
		const got = await appTokenFromBroker({ env: OIDC_ENV, fetchImpl, sleep: noSleep, timeoutMs: 20 })
		assert.equal(got.token, "ghs_app")
		assert.equal(n, 2)
	})
})

describe("retry and notice rules", () => {
	test("503 means turned off, so it isn't retried; other 5xx, 429 and network errors are", () => {
		assert.equal(isBrokerRetryable(503), false)
		for (const s of [0, 429, 500, 502, 504]) assert.equal(isBrokerRetryable(s), true, String(s))
		for (const s of [400, 401, 403, 404, 422]) assert.equal(isBrokerRetryable(s), false, String(s))
	})

	test("a fallback with no reply says so", () => {
		assert.match(brokerFallbackNotice({ status: 0 }), /no reply/)
	})
})

describe("main.mjs", () => {
	const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")

	test("with the App's key as inputs, the token service is never asked", () => {
		assert.match(main, /const creds = appCredentials\(env\)\n\tif \(!creds\) return brokeredAppToken\(\)/)
		assert.equal(main.match(/brokeredAppToken\(\)/g).length, 2, "defined once and called only from the no-key branch")
		assert.equal(main.match(/appTokenFromBroker\(/g).length, 1)
	})

	test("the identity-token variables are removed once spent", () => {
		assert.match(main, /delete env\.ACTIONS_ID_TOKEN_REQUEST_TOKEN/)
		assert.match(main, /delete env\.ACTIONS_ID_TOKEN_REQUEST_URL/)
	})

	test("received credentials are masked and redacted from what is posted", () => {
		assert.match(main, /::add-mask::\$\{secret\}/)
		assert.match(main, /RECEIVED_SECRETS\.push\(secret\)/)
		assert.match(main, /secretsNow = \(\) => \[\.\.\.STARTUP_SECRETS, \.\.\.RECEIVED_SECRETS/)
	})
})

describe("the agent's environment", () => {
	test("never gets GitHub's identity-token variables", () => {
		const out = childEnvFor({ ...OIDC_ENV, PATH: "/bin", TC_ACTION_TOKEN_BROKER_URL: DEFAULT_BROKER_URL })
		assert.equal(out.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined)
		assert.equal(out.ACTIONS_ID_TOKEN_REQUEST_URL, undefined)
	})
})
