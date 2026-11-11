import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readIntent, INTENT } from "../src/intent.mjs"

describe("readIntent — a comment naming a job", () => {
	test('"test this PR" asks for test-pr, the job that reads the diff', () => {
		assert.deepEqual(readIntent("test this PR against SHOP-221", { workflows: ["test-pr"] }), {
			kind: INTENT.WORKFLOW,
			workflow: "test-pr",
			preview: false,
		})
	})

	test("falls back to `test` where that is what the repository bound", () => {
		assert.equal(readIntent("test this PR", { workflows: ["test"] }).workflow, "test")
	})

	test("prefers test-pr when a repository binds both", () => {
		assert.equal(readIntent("test this PR", { workflows: ["test", "test-pr"] }).workflow, "test-pr")
	})

	test("with no bindings known, it is test-pr", () => {
		assert.equal(readIntent("test this PR").workflow, "test-pr")
	})

	test('"explain this failure" asks for rca, which is what explain is called here', () => {
		assert.equal(readIntent("explain this failure").workflow, "rca")
	})

	test('"fix the failing tests" asks for fix', () => {
		assert.equal(readIntent("fix the failing tests").workflow, "fix")
	})

	test('"find the bad PR" asks for verdict, which is what that job is called', () => {
		assert.equal(readIntent("find the bad PR").workflow, "verdict")
	})
})

describe("readIntent — a request that is not a job", () => {
	test("a request it cannot place is unknown, not a guess", () => {
		assert.equal(readIntent("make coffee").kind, INTENT.UNKNOWN)
	})

	test("an empty comment asks for nothing", () => {
		assert.equal(readIntent("").kind, INTENT.UNKNOWN)
	})
})

describe("readIntent — asking for something other than a job", () => {
	test('"stop" is a control word, not a job', () => {
		assert.equal(readIntent("stop").kind, INTENT.STOP)
	})

	test("stop wins over a job named in the same breath", () => {
		assert.equal(readIntent("stop, don't fix anything").kind, INTENT.STOP)
	})

	test('"set up this repo" opens the starter pull request', () => {
		assert.equal(readIntent("set up this repo").kind, INTENT.SETUP)
		assert.equal(readIntent("setup this repo").kind, INTENT.SETUP)
	})
})

describe("readIntent — preview is a modifier, not a job", () => {
	test("preview rides along with a named job", () => {
		assert.deepEqual(readIntent("test this PR, preview only"), {
			kind: INTENT.WORKFLOW,
			workflow: "test-pr",
			preview: true,
		})
	})

	test("preview on its own previews whatever the pipeline binds", () => {
		assert.deepEqual(readIntent("preview"), {
			kind: INTENT.WORKFLOW,
			workflow: null,
			preview: true,
		})
	})

	test('"re-check" runs the bound jobs again, for real', () => {
		assert.deepEqual(readIntent("re-check"), {
			kind: INTENT.WORKFLOW,
			workflow: null,
			preview: false,
		})
	})
})

describe("readIntent — quoted text is not a request", () => {
	// GitHub's "Quote reply" button copies the whole earlier comment in as `>` lines.
	test("a quoted line cannot start or stop anything", () => {
		assert.equal(readIntent("> stop\n\nthanks, carry on").kind, INTENT.UNKNOWN)
	})

	test("the person's own words still count under a quote", () => {
		assert.equal(readIntent("> explain this failure\n\nfix the failing tests").workflow, "fix")
	})
})

describe("readIntent — approving a proposal", () => {
	test('a bare "go" approves', () => {
		assert.equal(readIntent("go").kind, INTENT.GO)
	})

	test('"approved" approves too', () => {
		assert.equal(readIntent("approved").kind, INTENT.GO)
	})

	test("go with edits to the list still approves", () => {
		assert.equal(readIntent("go, but drop the third case").kind, INTENT.GO)
	})

	test("naming a job still asks for the job", () => {
		assert.equal(readIntent("go on then, fix the failing tests").workflow, "fix")
	})

	test('"going to look at this" is not an approval', () => {
		assert.equal(readIntent("going to look at this later").kind, INTENT.UNKNOWN)
	})
})

describe("readIntent — any BOUND workflow, not just the pretty phrases", () => {
	const bound = ["generate", "test", "rca", "fix", "validate", "results", "verdict", "automate", "mobile run"]

	test("a job asked for by name is found", () => {
		assert.equal(readIntent("generate", { workflows: bound }).workflow, "generate")
		assert.equal(readIntent("please run validate on this", { workflows: bound }).workflow, "validate")
	})

	test("a two-word job name works too", () => {
		assert.equal(readIntent("mobile run", { workflows: bound }).workflow, "mobile run")
	})

	test('the longer name wins, so "mobile run" is not read as "run"', () => {
		const d = readIntent("do a mobile run", { workflows: ["run", "mobile run"] })
		assert.equal(d.workflow, "mobile run")
	})

	test("the plain phrases still take precedence", () => {
		assert.equal(readIntent("explain this failure", { workflows: bound }).workflow, "rca")
	})

	test("a job the repository has NOT bound is still unplaceable", () => {
		assert.equal(readIntent("automate", { workflows: ["test"] }).kind, INTENT.UNKNOWN)
	})

	test("a name buried inside another word does not count", () => {
		assert.equal(readIntent("regenerated the lockfile", { workflows: ["generate"] }).kind, INTENT.UNKNOWN)
	})

	test("with no list passed, behaviour is unchanged", () => {
		assert.equal(readIntent("generate").kind, INTENT.UNKNOWN)
	})

	test("preview still rides along with a job named by name", () => {
		const d = readIntent("run automate, preview only", { workflows: bound })
		assert.equal(d.workflow, "automate")
		assert.equal(d.preview, true)
	})
})

describe("stop and set up are what the comment ASKS FOR, not words it contains", () => {
	const jobs = { workflows: ["test-pr", "fix", "rca"] }

	test('"stop" still stops, with or without politeness', () => {
		for (const body of ["stop", "please stop", "can you stop", "stop, don't fix anything"]) {
			assert.equal(readIntent(body, jobs).kind, INTENT.STOP, body)
		}
	})

	test('"don\'t stop until the tests pass" is not a stop', () => {
		assert.notEqual(readIntent("don't stop until the tests pass", jobs).kind, INTENT.STOP)
	})

	test('"set up this repo" still opens the setup', () => {
		for (const body of ["set up this repo", "please set up test companion", "setup this repository"]) {
			assert.equal(readIntent(body, jobs).kind, INTENT.SETUP, body)
		}
	})

	test('"the test setup is broken, fix it" runs fix, not setup', () => {
		const out = readIntent("the test setup is broken, fix it", jobs)
		assert.notEqual(out.kind, INTENT.SETUP)
		assert.equal(out.workflow, "fix")
	})
})

describe("naming a bound job — matched on whole words, never as a substring", () => {
	const bound = { workflows: ["generate", "test-pr", "mobile run", "rca"] }

	test("a name is found when it is said", () => {
		assert.equal(readIntent("please run generate", bound).workflow, "generate")
		assert.equal(readIntent("do a test-pr on this", bound).workflow, "test-pr")
	})

	test("a name inside a longer word is NOT a request for it", () => {
		assert.notEqual(readIntent("I regenerated the lockfile", bound).workflow, "generate")
	})

	test("longest wins, so 'mobile run' is never read as a shorter name", () => {
		assert.equal(readIntent("kick off mobile run", bound).workflow, "mobile run")
	})

	test("a name with regex metacharacters cannot blow up or match wildly", () => {
		const odd = { workflows: ["c++ build", "a.c"] }
		assert.equal(readIntent("start the c++ build", odd).workflow, "c++ build")
		// `a.c` unescaped would match "abc"; it must not.
		assert.notEqual(readIntent("abc", odd).workflow, "a.c")
	})
})

describe("a reply to a waiting proposal is read as an approval first", () => {
	const bound = { workflows: ["generate", "fix", "rca"], proposalWaiting: true }

	test("an approval carrying an edit still approves", () => {
		assert.equal(readIntent("go, and fix case 3's title", bound).kind, INTENT.GO)
		assert.equal(readIntent("approved, but rename the login case", bound).kind, INTENT.GO)
	})

	test("with no plan waiting, the same words ask for the job", () => {
		const idle = { workflows: ["generate", "fix", "rca"], proposalWaiting: false }
		assert.equal(readIntent("fix case 3's title", idle).kind, INTENT.WORKFLOW)
		assert.equal(readIntent("fix case 3's title", idle).workflow, "fix")
	})

	test("stop still wins over an approval, even with one waiting", () => {
		assert.equal(readIntent("stop", bound).kind, INTENT.STOP)
	})

	test("a comment that names no job and no approval is still unknown", () => {
		assert.equal(readIntent("looks good to me", bound).kind, INTENT.UNKNOWN)
	})
})

describe("go approves only when the comment opens with it", () => {
	const waiting = { workflows: ["test-pr", "fix", "rca"], proposalWaiting: true }
	const idle = { workflows: ["test-pr", "fix", "rca"], proposalWaiting: false }

	test("a comment that only mentions the word does not approve a waiting plan", () => {
		for (const body of [
			"don't go ahead yet, explain this failure",
			"no, do not approve that, test this PR instead",
			"wait before you go",
		]) {
			assert.notEqual(readIntent(body, waiting).kind, INTENT.GO, body)
		}
	})

	test("with nothing waiting, a passing mention is not read as an approval either", () => {
		assert.notEqual(readIntent("let's go over the login flow", idle).kind, INTENT.GO)
	})

	test("a comment that opens with the word still approves, edits and all", () => {
		for (const body of [
			"go",
			"Go!",
			"please go",
			"approved",
			"approve",
			"go, and fix case 3's title",
			"approved, but rename the login case",
			"go #1234567",
			"go — and pull the steps from https://github.com/o/r/pull/9#issuecomment-2345678901",
		]) {
			assert.equal(readIntent(body, waiting).kind, INTENT.GO, body)
		}
	})
})
