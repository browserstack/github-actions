import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const SRC = new URL("../src/", import.meta.url).pathname
const main = readFileSync(join(SRC, "main.mjs"), "utf8")

// `import { a, b } from "./x.mjs"` → { "./x.mjs": ["a","b"] }
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
				// A call, not a mention: `foo(` or `foo (`.
				const called = new RegExp(`\\b${name}\\s*\\(`).test(withoutImportBlock)
				if (called) {
					assert.ok(named.includes(name), `main.mjs calls ${name}() but does not import it from ${file}`)
				}
			}
		})
	}
})

describe("every src module is reachable", () => {
	// A module nobody imports is either dead or a missing wire-up.
	test("no source file is orphaned", () => {
		const files = readdirSync(SRC).filter((f) => f.endsWith(".mjs") && f !== "main.mjs")
		const allSource = files.map((f) => readFileSync(join(SRC, f), "utf8")).join("\n") + main
		for (const f of files) {
			assert.match(allSource, new RegExp(`"\\./${f.replace(".", "\\.")}"`), `${f} is imported by nothing`)
		}
	})
})

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

// The App's private key arrives in the environment and stays there.
describe("main.mjs — the App private key does not outlive its use", () => {
	const at = (needle) => {
		const i = main.indexOf(needle)
		assert.notEqual(i, -1, `main.mjs no longer contains ${JSON.stringify(needle)}`)
		return i
	}

	test("it is deleted from the environment", () => {
		assert.match(main, /delete env\.TC_ACTION_APP_PRIVATE_KEY/, "the key stays readable by every process this one starts")
	})

	test("deleted while minting the token, before anything else is spawned", () => {
		// The agent is the process that matters: it runs with --yolo and picks its own commands.
		assert.ok(
			at("delete env.TC_ACTION_APP_PRIVATE_KEY") < at('await runCapturingAnswer("tc"'),
			"the agent could still read it",
		)
	})
})

describe("main.mjs — a run that never ran does not spend the approval", () => {
	test("the consumed marker is gated on the outcome", () => {
		assert.match(
			main,
			/consumedMarker: approvalWasSpent\(outcome\) \? consumedMarker : ""/,
			"an approval is spent whatever happened, so a broken run blocks the commit for good",
		)
	})

	test("it is never passed unconditionally", () => {
		const bare = /\{\s*\.\.\.view,\s*approvalNote,\s*consumedMarker\s*\}/
		assert.ok(!bare.test(main), "the marker is attached without asking whether the run happened")
	})
})
