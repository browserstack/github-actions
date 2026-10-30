import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { parseFailedTests, buildAnnotations, MAX_ANNOTATIONS } from "../src/annotations.mjs"

const REPORT = [
	"workflow: test",
	"failed_test: Checkout > pays\ttests/checkout.spec.ts:18",
	"failed_test: Checkout > refunds\ttests/checkout.spec.ts",
	"failed_test: should log in",
	"outcome: failed",
].join("\n")

describe("parseFailedTests — reading the report back", () => {
	// parseSummary builds an object, so repeated keys collapse and only the
	// last failing test would survive. These need their own reader.
	test("keeps every failing test, not just the last one", () => {
		assert.equal(parseFailedTests(REPORT).length, 3)
	})

	test("splits the name from the location on the tab", () => {
		const [first] = parseFailedTests(REPORT)
		assert.deepEqual(first, { name: "Checkout > pays", file: "tests/checkout.spec.ts", line: 18 })
	})

	test("handles a file with no line", () => {
		assert.deepEqual(parseFailedTests(REPORT)[1], { name: "Checkout > refunds", file: "tests/checkout.spec.ts" })
	})

	test("handles a test with no location at all", () => {
		assert.deepEqual(parseFailedTests(REPORT)[2], { name: "should log in" })
	})

	test("returns nothing for a report with no failures, or no report", () => {
		assert.deepEqual(parseFailedTests("outcome: succeeded"), [])
		assert.deepEqual(parseFailedTests(undefined), [])
	})

	// A name is whatever the reporter printed. It must never be read as a
	// location, which is why the writer separates them with a tab.
	test("a colon in the test name is not a location", () => {
		const [t] = parseFailedTests("failed_test: handles a:b\treal.spec.ts:4")
		assert.deepEqual(t, { name: "handles a:b", file: "real.spec.ts", line: 4 })
	})
})

describe("buildAnnotations — FR-28, FR-48", () => {
	test("puts a failure on the line the test is declared on", () => {
		const [a] = buildAnnotations([{ name: "Checkout > pays", file: "tests/checkout.spec.ts", line: 18 }])
		assert.equal(a.path, "tests/checkout.spec.ts")
		assert.equal(a.start_line, 18)
		assert.equal(a.end_line, 18)
		assert.equal(a.annotation_level, "failure")
		assert.match(a.message, /Checkout > pays/)
	})

	// GitHub rejects an annotation with no line. A file with no line is still
	// worth pointing at, so it goes on line 1 — and the message says so, rather
	// than silently implying the failure is on the first line.
	test("falls back to the top of the file and says so", () => {
		const [a] = buildAnnotations([{ name: "Checkout > refunds", file: "tests/checkout.spec.ts" }])
		assert.equal(a.start_line, 1)
		assert.match(a.message, /line .*(not|unknown)|which line/i)
	})

	// Nowhere to point means no annotation. Inventing a path would put a
	// failure on a file that has nothing to do with it.
	test("skips a test with no file, rather than guessing one", () => {
		assert.deepEqual(buildAnnotations([{ name: "should log in" }]), [])
	})

	// GitHub accepts at most 50 annotations per request. A suite with 300
	// failures must not silently lose the whole set to a rejected call.
	test("never sends more than GitHub accepts", () => {
		const many = Array.from({ length: 300 }, (_, i) => ({ name: `t${i}`, file: "a.spec.ts", line: i + 1 }))
		assert.equal(buildAnnotations(many).length, MAX_ANNOTATIONS)
		assert.ok(MAX_ANNOTATIONS <= 50)
	})

	test("nothing failed, nothing to annotate", () => {
		assert.deepEqual(buildAnnotations([]), [])
		assert.deepEqual(buildAnnotations(undefined), [])
	})

	// An absolute path, or one climbing out of the repository, annotates
	// nothing on GitHub and may point at a file outside the checkout.
	test("refuses a path that is not inside the repository", () => {
		assert.deepEqual(buildAnnotations([{ name: "t", file: "/etc/passwd", line: 1 }]), [])
		assert.deepEqual(buildAnnotations([{ name: "t", file: "../outside.spec.ts", line: 1 }]), [])
	})
})
