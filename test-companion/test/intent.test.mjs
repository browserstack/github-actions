import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readIntent, INTENT } from "../src/intent.mjs"

/**
 * FR-34 — what did the comment actually ask for?
 *
 * The mapping has to happen HERE, before anything runs, because FR-34 says a
 * request we cannot map gets a reply and "nothing SHALL run". Handing the free
 * text to the agent and letting it decide would spend the customer's credits
 * working out that "make coffee" was never a job.
 */
describe("readIntent — a comment naming a job", () => {
	/**
	 * Caught by the FIRST LIVE RUN (rag_assignment PR #20). This table was
	 * written before `test-pr` existed and still said "test", so the flagship
	 * phrase resolved to the job whose wrongness is the entire reason test-pr
	 * exists — and the reply read "`test` is not bound to pull request
	 * comments" on a repository whose pipeline bound test-pr.
	 */
	test('"test this PR" asks for test-pr, the job that reads the diff', () => {
		assert.deepEqual(readIntent("test this PR against SHOP-221", { workflows: ["test-pr"] }), {
			kind: INTENT.WORKFLOW,
			workflow: "test-pr",
			preview: false,
		})
	})

	// A repository still bound to the older `test` keeps working: the phrase
	// prefers test-pr and falls back to whatever is actually bound.
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
	// FR-34: "A request it cannot map SHALL get a reply listing what it can do,
	// and nothing SHALL run." Unknown is a real answer, not a failure.
	test("a request it cannot place is unknown, not a guess", () => {
		assert.equal(readIntent("make coffee").kind, INTENT.UNKNOWN)
	})

	test("an empty comment asks for nothing", () => {
		assert.equal(readIntent("").kind, INTENT.UNKNOWN)
	})
})

describe("readIntent — asking for something other than a job", () => {
	test('"stop" is a control word, not a job — FR-35', () => {
		assert.equal(readIntent("stop").kind, INTENT.STOP)
	})

	// FR-35 gives stop its own 30-second deadline, so it must not lose to a job
	// word that happens to share the sentence.
	test("stop wins over a job named in the same breath", () => {
		assert.equal(readIntent("stop, don't fix anything").kind, INTENT.STOP)
	})

	test('"set up this repo" opens the starter pull request — FR-13', () => {
		assert.equal(readIntent("set up this repo").kind, INTENT.SETUP)
		assert.equal(readIntent("setup this repo").kind, INTENT.SETUP)
	})
})

describe("readIntent — preview is a modifier, not a job — FR-8", () => {
	test("preview rides along with a named job", () => {
		assert.deepEqual(readIntent("test this PR, preview only"), {
			kind: INTENT.WORKFLOW,
			workflow: "test-pr",
			preview: true,
		})
	})

	// FR-8: "Any comment MAY ask for a single preview run." With no job named,
	// the pipeline file still decides WHICH job — exactly as an event-driven run
	// does — so the workflow is left null and only the preview flag is set.
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
	/**
	 * GitHub's "Quote reply" button copies the whole earlier comment in as `>`
	 * lines. Without this, replying to Test Companion's own "say stop to cancel"
	 * message would cancel the run — the quote matches before the person's
	 * actual words do.
	 */
	test("a quoted line cannot start or stop anything", () => {
		assert.equal(readIntent("> stop\n\nthanks, carry on").kind, INTENT.UNKNOWN)
	})

	test("the person's own words still count under a quote", () => {
		assert.equal(readIntent("> explain this failure\n\nfix the failing tests").workflow, "fix")
	})
})

describe("readIntent — approving a proposal — FR-43", () => {
	// FR-43: "a reply of 'go', with or without edits to the case list, SHALL
	// start a new run on exactly the approved list."
	test('a bare "go" approves', () => {
		assert.equal(readIntent("go").kind, INTENT.GO)
	})

	test('"approved" approves too', () => {
		assert.equal(readIntent("approved").kind, INTENT.GO)
	})

	test("go with edits to the list still approves", () => {
		assert.equal(readIntent("go, but drop the third case").kind, INTENT.GO)
	})

	/**
	 * Checked AFTER the job words on purpose. "go" is two letters and turns up
	 * inside ordinary instructions, so a sentence that names a job is read as
	 * asking for that job, and only a reply that names none is an approval.
	 */
	test("naming a job still asks for the job", () => {
		assert.equal(readIntent("go on then, fix the failing tests").workflow, "fix")
	})

	test('"going to look at this" is not an approval', () => {
		assert.equal(readIntent("going to look at this later").kind, INTENT.UNKNOWN)
	})
})

describe("readIntent — any BOUND workflow, not just the pretty phrases — FR-34", () => {
	// FR-34 says "any bound workflow in plain words". Four hand-written phrases
	// covered four of the CLI's fourteen jobs; asking for the rest by name got
	// the can't-place reply. Naming a job IS plain words, so the job names the
	// repository has bound are accepted literally.
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

	// The written-out phrases still win, so "explain this failure" stays rca
	// rather than matching some job literally called "explain".
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
	/**
	 * Reported in review of PR #3101. STOP and SETUP were tested before the
	 * job phrases — deliberately, so "stop, don't fix anything" could not
	 * start a fix run. But they matched the word ANYWHERE, so:
	 *
	 *   "don't stop until the tests pass"      cancelled the run
	 *   "the test setup is broken, fix it"     opened a settings pull request
	 *
	 * Anchoring to the start keeps the case the ordering exists for and drops
	 * the ones where the word is incidental. A leading politeness is allowed,
	 * because "please stop" is plainly a stop.
	 */
	const jobs = ["test-pr", "fix", "rca"]

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

/**
 * Semgrep flagged the per-name `new RegExp` (browserstack/github-actions#91,
 * finding 8). These pin the behaviour that matters so it can be rewritten
 * without a pattern built from input.
 */
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
