import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * main.mjs is the one file here with no unit tests, by design: everything
 * decidable lives in the pure modules beside it and this is the I/O shell.
 *
 * The cost of that showed up twice in live runs. `renderProposalBody` and
 * `hasApproverEdits` were used in main.mjs and never imported, and nothing
 * caught it — a ReferenceError inside a function body does not throw until
 * that function runs, so neither `node --check` nor importing the module would
 * have found it. The whole 278-test suite passed while the Action crashed on a
 * runner.
 *
 * This closes that gap statically: every helper main.mjs CALLS must be in its
 * import list, and everything it imports must actually be exported.
 */
const SRC = new URL("../src/", import.meta.url).pathname
const main = readFileSync(join(SRC, "main.mjs"), "utf8")

/** `import { a, b } from "./x.mjs"` → { "./x.mjs": ["a","b"] } */
function localImports(source) {
	const out = {}
	for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.\/[^"]+)"/g)) {
		out[m[2]] = m[1]
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
	}
	return out
}

/** The names a module exports. */
function exportsOf(file) {
	const text = readFileSync(join(SRC, file), "utf8")
	return [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/g)].map((m) => m[1] ?? m[2])
}

const imports = localImports(main)
const withoutImportBlock = main.replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+"/g, "")

describe("main.mjs imports everything it uses", () => {
	test("it imports from the local modules at all", () => {
		assert.ok(Object.keys(imports).length > 5, "expected several local imports")
	})

	for (const [spec, named] of Object.entries(imports)) {
		const file = spec.replace("./", "")

		test(`every name main.mjs imports from ${file} is exported`, () => {
			const available = exportsOf(file)
			for (const n of named) {
				assert.ok(available.includes(n), `${file} does not export ${n}`)
			}
		})

		test(`every ${file} helper main.mjs CALLS is imported`, () => {
			for (const name of exportsOf(file)) {
				// A call, not a mention: `foo(` or `foo (`. Constants are not
				// called and are covered by the check above.
				const called = new RegExp(`\\b${name}\\s*\\(`).test(withoutImportBlock)
				if (called) {
					assert.ok(named.includes(name), `main.mjs calls ${name}() but does not import it from ${file}`)
				}
			}
		})
	}
})

describe("every src module is reachable", () => {
	// A module nobody imports is either dead or a missing wire-up. Both are
	// worth noticing; neither shows up in a passing test suite.
	test("no source file is orphaned", () => {
		const files = readdirSync(SRC).filter((f) => f.endsWith(".mjs") && f !== "main.mjs")
		const allSource = files.map((f) => readFileSync(join(SRC, f), "utf8")).join("\n") + main
		for (const f of files) {
			assert.match(allSource, new RegExp(`"\\./${f.replace(".", "\\.")}"`), `${f} is imported by nothing`)
		}
	})
})

/**
 * Found by a live run, run 41048725625. Asking "@test-companion explain why
 * the contract check is failing" worked: the Action found the red build and
 * passed it to the CLI. Replying "go" to the proposal it put up did NOT —
 * the CLI was spawned with no build at all and died with
 * `rca requires --context build=<url|number>`.
 *
 * The cause is pure ordering. `rca`, `fix` and `verdict` need to know which
 * build failed, and the lookup is guarded by `NEEDS_A_BUILD.has(plan.workflow)`.
 * On an approval, the workflow is not known from the comment — "go" names no
 * job — it comes from the proposal we are approving, and that assignment sat
 * BELOW the lookup. So the lookup ran against the wrong workflow, decided no
 * build was needed, and the run broke at the last step of the feature.
 *
 * Ordering inside one long procedure is not something the pure modules can
 * pin, so it is pinned here.
 */
describe("main.mjs — the failing build is resolved after the workflow is final", () => {
	const at = (needle) => {
		const i = main.indexOf(needle)
		assert.notEqual(i, -1, `main.mjs no longer contains ${JSON.stringify(needle)}`)
		return i
	}

	test("the proposal pins the workflow BEFORE the build is looked up", () => {
		assert.ok(
			at("plan.workflow = waiting.workflow") < at("NEEDS_A_BUILD.has(plan.workflow)"),
			"an approved rca/fix/verdict would be spawned with no build, and the CLI refuses it",
		)
	})

	test("there is exactly one build lookup, so the two paths cannot drift", () => {
		const calls = main.split("NEEDS_A_BUILD.has(plan.workflow)").length - 1
		assert.equal(calls, 1, `found ${calls} build lookups; two copies will diverge`)
	})
})

/**
 * Review of PR #3101, blocker B3.
 *
 * The App's private key arrives in the environment and stays there. Anything
 * spawned afterwards inherits it — and the agent runs with --yolo, so "what
 * gets spawned afterwards" includes programs it chose.
 *
 * The git half of B3 is closed in push-work.mjs (minimal env, hooks and
 * fsmonitor off, config allow-listed, binary pinned). This is the other half:
 * once the key has been used, it should not still be readable.
 */
describe("main.mjs — the App private key does not outlive its use", () => {
	const at = (needle) => {
		const i = main.indexOf(needle)
		assert.notEqual(i, -1, `main.mjs no longer contains ${JSON.stringify(needle)}`)
		return i
	}

	test("it is deleted from the environment", () => {
		assert.match(
			main,
			/delete env\.TC_ACTION_APP_PRIVATE_KEY/,
			"the key stays readable by every process this one starts",
		)
	})

	test("deleted while minting the token, before anything else is spawned", () => {
		// The agent is the process that matters: it runs with --yolo and picks
		// its own commands.
		assert.ok(at("delete env.TC_ACTION_APP_PRIVATE_KEY") < at('spawnSync("tc"'), "the agent could still read it")
	})
})
