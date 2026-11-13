import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, createVerify } from "node:crypto"
import {
	appCredentials,
	jwtClaims,
	signJwt,
	installationTokenRequest,
	appApi,
	isRetryable,
	retryDelayMs,
	installationLookupMessage,
} from "../src/app-auth.mjs"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs1", format: "pem" })

describe("appCredentials", () => {
	test("both halves are needed", () => {
		assert.equal(appCredentials({ TC_ACTION_APP_ID: "1", TC_ACTION_APP_PRIVATE_KEY: "k" })?.appId, "1")
		assert.equal(appCredentials({ TC_ACTION_APP_ID: "1" }), undefined)
		assert.equal(appCredentials({ TC_ACTION_APP_PRIVATE_KEY: "k" }), undefined)
		assert.equal(appCredentials({}), undefined)
	})

	// A secret pasted into the settings UI picks up whitespace remarkably often.
	test("whitespace around them is not a credential", () => {
		assert.equal(appCredentials({ TC_ACTION_APP_ID: "  ", TC_ACTION_APP_PRIVATE_KEY: "k" }), undefined)
	})
})

describe("jwtClaims", () => {
	const now = 1_800_000_000

	test("issued by the app", () => {
		assert.equal(jwtClaims("12345", now).iss, "12345")
	})

	// GitHub rejects a JWT whose iat is in the future, and runner clocks drift.
	test("issued a minute ago, to survive clock drift", () => {
		assert.equal(jwtClaims("1", now).iat, now - 60)
	})

	// GitHub refuses anything over ten minutes outright.
	test("expires inside GitHub's ten-minute ceiling", () => {
		const { iat, exp } = jwtClaims("1", now)
		assert.ok(exp - iat <= 600, `lifetime ${exp - iat}s must be at most 600`)
		assert.ok(exp > now, "must not already be expired")
	})
})

describe("signJwt", () => {
	test("three base64url parts", () => {
		const parts = signJwt({ appId: "1", privateKey: pem, now: 1_800_000_000 }).split(".")
		assert.equal(parts.length, 3)
		for (const p of parts) assert.doesNotMatch(p, /[+/=]/, "must be base64url, not base64")
	})

	test("the payload is the claims", () => {
		const jwt = signJwt({ appId: "42", privateKey: pem, now: 1_800_000_000 })
		const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString())
		assert.equal(payload.iss, "42")
	})

	test("it really is signed by that key", () => {
		const jwt = signJwt({ appId: "1", privateKey: pem, now: 1_800_000_000 })
		const [h, p, sig] = jwt.split(".")
		const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"))
		assert.equal(ok, true)
	})

	test("the header says RS256, which is the only algorithm GitHub accepts", () => {
		const jwt = signJwt({ appId: "1", privateKey: pem, now: 1_800_000_000 })
		const header = JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString())
		assert.equal(header.alg, "RS256")
	})
})

describe("installationTokenRequest", () => {
	test("scoped to this repository alone", () => {
		assert.deepEqual(installationTokenRequest("acme/shop").repositories, ["shop"])
	})

	test("the owner is not part of the repository name", () => {
		assert.deepEqual(installationTokenRequest("acme/deep-name").repositories, ["deep-name"])
	})

	test("only the permissions the Action actually uses", () => {
		const { permissions } = installationTokenRequest("acme/shop")
		assert.deepEqual(Object.keys(permissions).sort(), ["actions", "checks", "contents", "pull_requests"])
		for (const v of Object.values(permissions)) assert.equal(v, "write")
	})

	test("a malformed repository asks for nothing rather than everything", () => {
		assert.equal(installationTokenRequest("not-a-repo"), undefined)
		assert.equal(installationTokenRequest(""), undefined)
		assert.equal(installationTokenRequest(undefined), undefined)
	})
})

describe("appApi", () => {
	const fakeFetch = (status, json, seen) => async (url, init) => {
		Object.assign(seen, { url, init })
		return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => json }
	}

	test("sends the JWT as Bearer, which GitHub requires for an App", async () => {
		const seen = {}
		const r = await appApi("repos/o/r/installation", { jwt: "J", fetchImpl: fakeFetch(200, { id: 7 }, seen) })
		assert.equal(seen.init.headers.Authorization, "Bearer J")
		assert.equal(seen.url, "https://api.github.com/repos/o/r/installation")
		assert.deepEqual(r, { ok: true, status: 200, data: { id: 7 }, reason: "", attempts: 1 })
	})

	test("uses the server's API address when given", async () => {
		const seen = {}
		await appApi("x", { jwt: "J", apiUrl: "https://ghe.example/api/v3/", fetchImpl: fakeFetch(200, {}, seen) })
		assert.equal(seen.url, "https://ghe.example/api/v3/x")
	})

	test("sends a JSON body on POST", async () => {
		const seen = {}
		await appApi("x", { jwt: "J", method: "POST", body: { a: 1 }, fetchImpl: fakeFetch(201, {}, seen) })
		assert.equal(seen.init.method, "POST")
		assert.equal(seen.init.body, '{"a":1}')
		assert.equal(seen.init.headers["Content-Type"], "application/json")
	})

	test("a failure carries GitHub's message and status, never the JWT", async () => {
		const r = await appApi("x", { jwt: "SECRET-JWT", fetchImpl: fakeFetch(401, { message: "Bad credentials" }, {}) })
		assert.equal(r.ok, false)
		assert.equal(r.reason, "Bad credentials (HTTP 401)")
		assert.doesNotMatch(r.reason, /SECRET-JWT/)
	})

	test("a network failure is reported, not thrown", async () => {
		const r = await appApi("x", { jwt: "J", sleep: async () => {}, fetchImpl: async () => { throw new Error("ECONNRESET") } })
		assert.equal(r.ok, false)
		assert.equal(r.status, 0)
		assert.match(r.reason, /ECONNRESET/)
	})
})

describe("installationLookupMessage", () => {
	test("only a 404 means the App is not installed", () => {
		const m = installationLookupMessage({ status: 404, reason: "Not Found (HTTP 404)" })
		assert.equal(m.level, "notice")
		assert.match(m.text, /not installed on this repository/)
	})

	test("any other failure is a warning that carries GitHub's reason", () => {
		const m = installationLookupMessage({ status: 401, reason: "A JSON web token could not be decoded (HTTP 401)" })
		assert.equal(m.level, "warning")
		assert.match(m.text, /A JSON web token could not be decoded \(HTTP 401\)/)
		assert.doesNotMatch(m.text, /not installed/)
	})
})

describe("appApi retries a passing failure", () => {
	// A response whose status and body change call by call; `throws` makes that call a network error.
	const sequence = (steps) => {
		let i = 0
		const fetchImpl = async () => {
			const step = steps[Math.min(i++, steps.length - 1)]
			if (step.throws) throw new Error(step.throws)
			return {
				ok: step.status >= 200 && step.status < 300,
				status: step.status,
				statusText: "",
				headers: { get: (h) => (h.toLowerCase() === "retry-after" ? (step.retryAfter ?? null) : null) },
				json: async () => step.body ?? {},
			}
		}
		return { fetchImpl, calls: () => i }
	}
	const noSleep = []
	const sleep = async (ms) => {
		noSleep.push(ms)
	}

	test("a network error, then success", async () => {
		const s = sequence([{ throws: "fetch failed" }, { status: 200, body: { id: 7 } }])
		const r = await appApi("x", { jwt: "J", fetchImpl: s.fetchImpl, sleep })
		assert.equal(r.ok, true)
		assert.equal(r.attempts, 2)
		assert.equal(s.calls(), 2)
	})

	test("a 502, then success", async () => {
		const s = sequence([{ status: 502 }, { status: 201, body: { token: "t" } }])
		const r = await appApi("x", { jwt: "J", method: "POST", body: {}, fetchImpl: s.fetchImpl, sleep })
		assert.equal(r.ok, true)
		assert.equal(r.data.token, "t")
		assert.equal(r.attempts, 2)
	})

	test("401, 403, 404 and 422 are never retried", async () => {
		for (const status of [401, 403, 404, 422]) {
			const s = sequence([{ status, body: { message: "no" } }, { status: 200 }])
			const r = await appApi("x", { jwt: "J", fetchImpl: s.fetchImpl, sleep })
			assert.equal(r.ok, false, String(status))
			assert.equal(s.calls(), 1, String(status))
		}
	})

	test("three failures in a row give up with the last failure, as before", async () => {
		const s = sequence([{ throws: "fetch failed" }])
		const r = await appApi("x", { jwt: "J", fetchImpl: s.fetchImpl, sleep })
		assert.equal(r.ok, false)
		assert.equal(r.status, 0)
		assert.equal(r.attempts, 3)
		assert.equal(s.calls(), 3)
		assert.match(r.reason, /could not reach GitHub: fetch failed/)
		assert.match(installationLookupMessage(r).text, /could not sign in as the GitHub App \(could not reach GitHub: fetch failed\)/)
	})

	test("waits 1s then 3s, and a Retry-After wins, capped at 10s", () => {
		assert.equal(retryDelayMs({ status: 0 }, 1), 1000)
		assert.equal(retryDelayMs({ status: 502 }, 2), 3000)
		assert.equal(retryDelayMs({ status: 429, retryAfter: "2" }, 1), 2000)
		assert.equal(retryDelayMs({ status: 429, retryAfter: "120" }, 1), 10000)
	})

	test("only network errors, 429 and 5xx are worth another try", () => {
		assert.equal(isRetryable({ status: 0 }), true)
		assert.equal(isRetryable({ status: 429 }), true)
		assert.equal(isRetryable({ status: 503 }), true)
		for (const status of [200, 201, 401, 403, 404, 422]) assert.equal(isRetryable({ status }), false, String(status))
	})
})

describe("appApi gives each call a time limit", () => {
	test("every request carries an abort signal", async () => {
		let seen
		await appApi("x", { jwt: "J", fetchImpl: async (_u, init) => ((seen = init), { ok: true, status: 200, json: async () => ({}) }) })
		assert.ok(seen.signal instanceof AbortSignal)
	})

	test("a call that stalls is aborted, counted as a network error and retried", async () => {
		let calls = 0
		const fetchImpl = (_u, init) =>
			new Promise((_resolve, reject) => {
				calls++
				init.signal.addEventListener("abort", () => reject(init.signal.reason))
			})
		const r = await appApi("x", { jwt: "J", fetchImpl, sleep: async () => {}, timeoutMs: 5 })
		assert.equal(r.ok, false)
		assert.equal(r.status, 0)
		assert.match(r.reason, /no reply within/)
		assert.equal(calls, 3)
	})
})
