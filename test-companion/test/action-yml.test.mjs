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
