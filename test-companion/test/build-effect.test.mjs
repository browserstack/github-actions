import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { OUTCOMES, stepShouldFail, BUILD_EFFECTS } from "../src/outcome.mjs"

// A run that broke should redden the build.

// The run itself did not work.
const BROKEN = [OUTCOMES.RUN_BROKE, OUTCOMES.COULD_NOT_RUN, OUTCOMES.STOPPED_AT_LIMIT]

describe("the default reddens a broken run and nothing else", () => {
	test("a run that broke fails the step", () => {
		for (const o of BROKEN) {
			assert.equal(stepShouldFail(BUILD_EFFECTS.FAIL_ON_BREAK, o), true, `${o} left the step green`)
		}
	})

	test("tests failing does not", () => {
		assert.equal(stepShouldFail(BUILD_EFFECTS.FAIL_ON_BREAK, OUTCOMES.TESTS_FAILED), false)
	})

	test("neither does a success, or a run that never happened", () => {
		assert.equal(stepShouldFail(BUILD_EFFECTS.FAIL_ON_BREAK, OUTCOMES.SUCCEEDED), false)
		assert.equal(stepShouldFail(BUILD_EFFECTS.FAIL_ON_BREAK, OUTCOMES.SKIPPED), false)
	})

	test("saying nothing means the default", () => {
		assert.equal(stepShouldFail(undefined, OUTCOMES.RUN_BROKE), true)
		assert.equal(stepShouldFail("", OUTCOMES.RUN_BROKE), true)
		assert.equal(stepShouldFail(undefined, OUTCOMES.TESTS_FAILED), false)
	})

	test("a misspelling lands on the default, not on the quietest setting", () => {
		assert.equal(stepShouldFail("reprot", OUTCOMES.RUN_BROKE), true)
		assert.equal(stepShouldFail("FAIL_HARD", OUTCOMES.RUN_BROKE), true)
	})
})

describe("the two explicit settings keep their meaning", () => {
	test("report is still never red", () => {
		for (const o of Object.values(OUTCOMES)) {
			assert.equal(stepShouldFail("report", o), false, `${o} reddened the step under report`)
		}
	})

	test("an existing off keeps working as report", () => {
		for (const o of Object.values(OUTCOMES)) {
			assert.equal(stepShouldFail("off", o), false, `${o} reddened the step under off`)
		}
	})

	test("fail is still red on anything that is not a success", () => {
		for (const o of [...BROKEN, OUTCOMES.TESTS_FAILED]) {
			assert.equal(stepShouldFail("fail", o), true, `${o} left the step green under fail`)
		}
		assert.equal(stepShouldFail("fail", OUTCOMES.SUCCEEDED), false)
		assert.equal(stepShouldFail("fail", OUTCOMES.SKIPPED), false)
	})

	test("case and stray spaces do not decide whether a build goes red", () => {
		assert.equal(stepShouldFail("  Report  ", OUTCOMES.RUN_BROKE), false)
		assert.equal(stepShouldFail(" FAIL ", OUTCOMES.TESTS_FAILED), true)
	})
})

describe("the input documents what it does", () => {
	const yml = readFileSync(new URL("../action.yml", import.meta.url), "utf8")
	const input = yml.slice(yml.indexOf("build-effect:"), yml.indexOf("github-token:"))

	test("its default is the new one", () => {
		assert.match(input, /default:\s*"fail-on-break"/)
	})

	test("it no longer advertises off, which never did anything of its own", () => {
		assert.doesNotMatch(input, /\boff\b/)
	})

	test("it names both of the settings that do something different", () => {
		assert.match(input, /report/)
		assert.match(input, /fail/)
	})
})

describe("an unrecognised value explains the reddening it causes", () => {
	test("it warns, naming the value and the default", () => {
		const said = []
		const real = process.stdout.write.bind(process.stdout)
		process.stdout.write = (c, ...rest) => {
			said.push(String(c))
			return real(c, ...rest)
		}
		try {
			stepShouldFail("none", OUTCOMES.RUN_BROKE)
		} finally {
			process.stdout.write = real
		}
		const warning = said.find((l) => l.includes("::warning::"))
		assert.ok(warning, `expected a workflow warning, got: ${said.join("")}`)
		assert.match(warning, /none/)
		assert.match(warning, /fail-on-break/)
	})
})
