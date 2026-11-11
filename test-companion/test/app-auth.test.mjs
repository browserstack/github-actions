import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, createVerify } from "node:crypto"
import {
	appCredentials,
	jwtClaims,
	signJwt,
	installationTokenRequest,
	ghFailureReason,
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

describe("App sign-in failures say why", () => {
	test("GitHub's reason is taken from gh's error output", () => {
		assert.equal(ghFailureReason({ stderr: "gh: Bad credentials (HTTP 401)\n" }), "Bad credentials (HTTP 401)")
	})

	test("an empty error output still gives a reason", () => {
		assert.equal(ghFailureReason({ stderr: "" }), "no detail from GitHub")
		assert.equal(ghFailureReason(undefined), "no detail from GitHub")
	})

	test("only a 404 means the App is not installed", () => {
		const m = installationLookupMessage({ stderr: "gh: Not Found (HTTP 404)" })
		assert.equal(m.level, "notice")
		assert.match(m.text, /not installed on this repository/)
	})

	test("any other failure is a warning that carries GitHub's reason", () => {
		const m = installationLookupMessage({ stderr: "gh: A JSON web token could not be decoded (HTTP 401)" })
		assert.equal(m.level, "warning")
		assert.match(m.text, /A JSON web token could not be decoded \(HTTP 401\)/)
		assert.doesNotMatch(m.text, /not installed/)
	})
})
