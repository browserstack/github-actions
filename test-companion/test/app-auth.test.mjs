import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, createVerify } from "node:crypto"
import {
	appCredentials,
	jwtClaims,
	signJwt,
	installationTokenRequest,
	appApi,
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
		assert.deepEqual(r, { ok: true, status: 200, data: { id: 7 }, reason: "" })
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
		const r = await appApi("x", { jwt: "J", fetchImpl: async () => { throw new Error("ECONNRESET") } })
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
