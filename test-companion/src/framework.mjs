/**
 * Which test framework does this repository use?
 *
 * Pure: the caller does the directory walk and the package.json read, this
 * decides. Guessing WRONG is worse than not guessing — a starter file naming
 * Cypress at a Playwright shop tells the team Test Companion understood their
 * setup when it did not — so anything unrecognised returns undefined and the
 * starter stays generic.
 */

/**
 * A config file is stronger evidence than a dependency: it is what actually
 * runs. A repository can carry `@playwright/test` from an experiment while
 * its suite is Cypress.
 */
const BY_CONFIG = [
	[/(^|\/)playwright\.config\.[cm]?[jt]s$/i, "Playwright"],
	[/(^|\/)cypress\.config\.[cm]?[jt]s$/i, "Cypress"],
	[/(^|\/)wdio\.conf\.[cm]?[jt]s$/i, "WebdriverIO"],
]

const BY_DEPENDENCY = [
	[/^@playwright\/test$|^playwright$/i, "Playwright"],
	[/^cypress$/i, "Cypress"],
	[/^@wdio\/cli$|^webdriverio$/i, "WebdriverIO"],
	[/^selenium-webdriver$/i, "Selenium"],
]

export function detectFramework({ filenames = [], deps = {} } = {}) {
	for (const [pattern, name] of BY_CONFIG) {
		if (filenames.some((f) => pattern.test(String(f)))) return name
	}
	for (const [pattern, name] of BY_DEPENDENCY) {
		if (Object.keys(deps ?? {}).some((d) => pattern.test(d))) return name
	}
	return undefined
}
