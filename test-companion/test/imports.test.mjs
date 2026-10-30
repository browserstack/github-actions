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
