import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { detectFramework } from "../src/framework.mjs"

describe("detectFramework — FR-13", () => {
	test("a config file names the framework", () => {
		assert.equal(detectFramework({ filenames: ["playwright.config.ts", "src/app.ts"] }), "Playwright")
		assert.equal(detectFramework({ filenames: ["cypress.config.js"] }), "Cypress")
		assert.equal(detectFramework({ filenames: ["wdio.conf.js"] }), "WebdriverIO")
	})

	test("a dependency names it too", () => {
		assert.equal(detectFramework({ deps: { "@playwright/test": "^1.0.0" } }), "Playwright")
		assert.equal(detectFramework({ deps: { cypress: "^13" } }), "Cypress")
		assert.equal(detectFramework({ deps: { "@wdio/cli": "^8" } }), "WebdriverIO")
		assert.equal(detectFramework({ deps: { "selenium-webdriver": "^4" } }), "Selenium")
	})

	test("a config file beats a dependency, because it is what actually runs", () => {
		const found = detectFramework({
			filenames: ["cypress.config.js"],
			deps: { "@playwright/test": "^1.0.0" },
		})
		assert.equal(found, "Cypress")
	})

	/**
	 * Guessing wrong is worse than not guessing: the starter file would tell the
	 * team Test Companion had understood their setup when it had not.
	 */
	test("nothing recognisable is undefined, not a guess", () => {
		assert.equal(detectFramework({ filenames: ["README.md"], deps: { react: "^18" } }), undefined)
		assert.equal(detectFramework({}), undefined)
		assert.equal(detectFramework(), undefined)
	})

	test("a nested config file still counts", () => {
		assert.equal(detectFramework({ filenames: ["e2e/playwright.config.js"] }), "Playwright")
	})
})
