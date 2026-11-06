import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { childEnvFor } from "../src/child-env.mjs"

describe("childEnvFor — what the agent's shell can see", () => {
	test("the CLI's own configuration and credentials get through", () => {
		const out = childEnvFor({ TC_PIPELINE_CONFIG: "p.yml", BROWSERSTACK_USERNAME: "u", PATH: "/bin" })
		assert.equal(out.TC_PIPELINE_CONFIG, "p.yml")
		assert.equal(out.BROWSERSTACK_USERNAME, "u")
		assert.equal(out.PATH, "/bin")
	})

	test("the GitHub token never does", () => {
		const out = childEnvFor({ GH_TOKEN: "ghs_x", GITHUB_TOKEN: "ghs_y" })
		assert.equal(out.GH_TOKEN, undefined)
		assert.equal(out.GITHUB_TOKEN, undefined)
	})

	/**
	 * The one the allowlist would have let through. TC_ is a kept PREFIX, so
	 * the App's private key — TC_ACTION_APP_PRIVATE_KEY — matched it and would
	 * have been handed to a shell running commands the model chose.
	 *
	 * That key can mint installation tokens for every repository the App is on,
	 * which is a far worse thing to leak than the workflow token the allowlist
	 * was written to keep out.
	 */
	test("the App's private key never does either, despite its TC_ prefix", () => {
		const out = childEnvFor({
			TC_ACTION_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
			TC_ACTION_APP_ID: "12345",
			TC_PIPELINE_CONFIG: "p.yml",
		})
		assert.equal(out.TC_ACTION_APP_PRIVATE_KEY, undefined)
		assert.equal(out.TC_ACTION_APP_ID, undefined)
		assert.equal(out.TC_PIPELINE_CONFIG, "p.yml", "ordinary TC_ settings must still get through")
	})

	test("an unrecognised variable is not passed on", () => {
		assert.equal(childEnvFor({ AWS_SECRET_ACCESS_KEY: "x" }).AWS_SECRET_ACCESS_KEY, undefined)
	})

	test("an unset variable is dropped rather than passed as undefined", () => {
		assert.equal("PATH" in childEnvFor({ PATH: undefined }), false)
	})
})
