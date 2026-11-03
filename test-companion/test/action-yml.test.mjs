import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const actionYml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "action.yml"), "utf8")

/** The composite steps, split on the step marker so each carries its own env. */
const steps = actionYml.split(/\n {8}- name: /).slice(1)
const nameOf = (s) => s.split("\n")[0].trim()

describe("action.yml — every step that runs tc must pin it (FR-2)", () => {
	/**
	 * Found live on 2026-10-29, the day tc 1.1.9 shipped.
	 *
	 * The pin was set on the Run step only. But `Sign in` runs `tc auth login`
	 * FIRST, unpinned, so the CLI self-upgraded there — and the Run step then
	 * correctly reported a mismatch against the very binary the pin existed to
	 * preserve:
	 *
	 *   tc is pinned to version 1.1.8 but the installed binary is 1.1.9
	 *
	 * So asking for a pinned version MADE THE RUN FAIL, which is the exact
	 * opposite of what FR-2 promises. The spec lists FR-2 as "Done, but NEVER
	 * EXECUTED"; this is what was hiding in it.
	 *
	 * `tc --version` is exempt: upgrade.shouldSkip returns true for it, because
	 * swapping the binary before reporting its version would defeat the point
	 * of asking.
	 */
	// Directly (`tc auth login`) or indirectly — the Run step shells out to
	// main.mjs, which spawns tc for the workflow run and for `workflow
	// bindings`. Both need the pin; only one of them says "tc" in the YAML.
	const runsTc = (body) => {
		const withoutVersionChecks = body.replace(/^.*--version.*$/gm, "")
		return /(^|[\s"'`/])tc\s/m.test(withoutVersionChecks) || /main\.mjs/.test(withoutVersionChecks)
	}

	for (const step of steps) {
		const name = nameOf(step)
		if (!runsTc(step)) continue
		test(`"${name}" sets TC_PIN_VERSION`, () => {
			assert.match(
				step,
				/TC_PIN_VERSION:/,
				`step "${name}" runs tc without the pin, so the CLI can self-upgrade before a later pinned step rejects it`,
			)
		})
	}

	test("at least one step was actually checked, so this cannot pass vacuously", () => {
		const checked = steps.filter(runsTc).map(nameOf)
		assert.ok(checked.length >= 2, `expected at least the sign-in and run steps, checked: ${checked.join(", ")}`)
	})
})

/**
 * A live run's dedupe claim is a real `git push` to origin, and the workflow
 * sets `persist-credentials: false`, so git has no credential for it. Pointing
 * git at gh's stored credential fixes that without putting a token in any
 * environment variable.
 *
 * The teardown is the part worth pinning. The helper goes in the GLOBAL git
 * config, which outlives the job on a self-hosted runner, and it points at a
 * config dir the cleanup deletes. Left behind, the next job on that runner
 * gets a helper that answers nothing and a git command that stops to ask for
 * a password instead of failing.
 */
describe("action.yml — git's credential helper is cleaned up", () => {
	test("git is pointed at gh's credential", () => {
		assert.match(actionYml, /gh auth setup-git/, "a live run's dedupe claim has no credential to push with")
	})

	test("it is scoped to one host, not every remote", () => {
		assert.match(actionYml, /gh auth setup-git --hostname github\.com/)
	})

	test("whatever sets the helper also unsets it", () => {
		if (!/gh auth setup-git/.test(actionYml)) return
		// `--unset` WITH A VALUE PATTERN, not `--unset-all`. The blanket form
		// removed every helper for that URL, including ones the runner's owner
		// set up before us, and ran even when our own setup-git had failed
		// (STM-5434 review, PR #3286).
		assert.match(
			actionYml,
			/--unset "credential:\/\/\$host\.helper"|--unset "credential\.https:\/\/\$host\.helper"/,
			"a self-hosted runner keeps a helper pointing at a deleted config dir",
		)
	})

	test("the teardown runs even when the job failed", () => {
		const teardown = actionYml.slice(actionYml.indexOf("Take gh's credentials back off the runner"))
		assert.match(teardown.slice(0, 200), /if: always\(\)/)
	})

	// Set up after the login succeeds, not before: there is nothing stored to
	// hand git until then.
	test("the helper is set up only on the successful-login path", () => {
		const login = actionYml.indexOf("gh auth login --with-token")
		const setup = actionYml.indexOf("gh auth setup-git")
		assert.ok(login !== -1 && setup > login, "setup-git runs before there is a credential to use")
	})
})

/**
 * STM-5434 review (kritansh20, PR #3286). The cleanup must not damage a
 * self-hosted runner's own git configuration.
 */
describe("action.yml — the cleanup only removes what this job added", () => {
	test("it never uses the blanket --unset-all on a credential helper", () => {
		assert.doesNotMatch(
			actionYml,
			/--unset-all credential\./,
			"that removes every helper for the host, including the runner owner's",
		)
	})

	test("and it only runs when this job actually added one", () => {
		assert.match(actionYml, /TC_ADDED_GIT_HELPER/, "a failed setup-git must not trigger a cleanup of somebody else's helper")
	})
})

/**
 * CodeRabbit, PR #3286. `gh auth setup-git` writes TWO values per host: an
 * empty helper that clears any general helper inherited from a broader scope,
 * and then its own. Removing only the second leaves the runner's own helper
 * disabled for that host.
 */
describe("action.yml — the cleanup removes both of setup-git's entries", () => {
	test("the empty helper is unset too", () => {
		assert.match(actionYml, /--unset "credential[^"]*\.helper" '\^\$'/, "an empty helper keeps a general one disabled")
	})

	test("and the config dir is only deleted when this job created it", () => {
		assert.match(actionYml, /TC_OWNS_GH_CONFIG_DIR/)
		assert.match(actionYml, /leaving it alone/, "a runner that exports GH_CONFIG_DIR itself must keep its own credentials")
	})
})
