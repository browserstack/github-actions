/** Detect the repository's test framework, or undefined when unsure. */

// A config file is stronger evidence than a dependency.
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
