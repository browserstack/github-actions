import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
	pipelineConfigPath,
	renderNoPipelineReport,
	STARTER_PIPELINE,
	settingsRef,
	renderSetupPr,
	starterPipelineFor,
} from "../src/starter.mjs"
import { TC_EVENTS } from "../src/plan-run.mjs"

describe("pipelineConfigPath — the same file the CLI would read", () => {
	// Checking a different path than the CLI would is worse than not checking:
	// the Action would report "no settings file" for a repo that has one.
	test("defaults to the repository root file", () => {
		assert.equal(pipelineConfigPath("", {}), "testcompanion-pipeline.yml")
	})

	test("an explicit config input wins", () => {
		assert.equal(pipelineConfigPath("ci/tc.yml", { TC_PIPELINE_CONFIG: "env.yml" }), "ci/tc.yml")
	})

	test("then the environment variable, matching effectiveConfigPath in the CLI", () => {
		assert.equal(pipelineConfigPath("", { TC_PIPELINE_CONFIG: "env.yml" }), "env.yml")
	})

	test("whitespace around the input is not a path", () => {
		assert.equal(pipelineConfigPath("  ", {}), "testcompanion-pipeline.yml")
	})
})

describe("no pipeline file — FR-13", () => {
	// Installing the Action and getting a red build with "open
	// testcompanion-pipeline.yml: no such file or directory" is the worst
	// possible first run. FR-13: a clean pass, and the file they need.
	test("the report says plainly that nothing is configured yet", () => {
		const out = renderNoPipelineReport("testcompanion-pipeline.yml")
		assert.match(out, /testcompanion-pipeline\.yml/)
		// Only the prose. The starter itself legitimately mentions failed
		// builds, since explaining one is a job you can bind.
		const prose = out.split("```")[0]
		assert.ok(!/error|failed|cannot|could not/i.test(prose), prose)
	})

	test("and hands over a starter they can copy", () => {
		const out = renderNoPipelineReport("testcompanion-pipeline.yml")
		assert.match(out, /```ya?ml/)
		assert.match(out, /workflows:/)
	})

	test("the starter binds at least one job, or copying it changes nothing", () => {
		assert.match(STARTER_PIPELINE, /workflow:\s*\S/)
	})

	// Every `on:` in the starter must be a name the CLI's matcher knows, or the
	// file we hand people silently never fires.
	test("every event the starter binds is a real pipeline event", () => {
		const known = new Set(Object.values(TC_EVENTS))
		const bound = [...STARTER_PIPELINE.matchAll(/^\s*on:\s*(\S+)/gm)].map((m) => m[1])
		assert.ok(bound.length > 0, "the starter binds nothing")
		for (const e of bound) assert.ok(known.has(e), `${e} is not a pipeline event`)
	})

	// It is handed to someone who has not run Test Companion before. Starting
	// them on a mode that writes to their repository is the wrong default.
	test("the starter starts in preview, so a first run writes nothing", () => {
		assert.match(STARTER_PIPELINE, /mode:\s*preview/)
	})
})

describe("which branch the settings file is read from — FR-7", () => {
	/**
	 * The safety fix. Read from the branch under test, a pull request can edit
	 * its own rules and be obeyed: switch itself from preview to live, delete its
	 * own spending limit, or name its own Test Management destination. FR-7:
	 * read from the default branch, so an edit takes effect only once it merges.
	 */
	test("the repository's default branch, not the branch under test", () => {
		assert.equal(settingsRef({ repository: { default_branch: "trunk" } }, {}), "trunk")
	})

	test("falls back to the checkout's own default when the payload carries none", () => {
		assert.equal(settingsRef({}, { GITHUB_DEFAULT_BRANCH: "develop" }), "develop")
	})

	// Guessing "main" is better than guessing the pull request's branch: the
	// worst case is "no settings file", which is a clean skip, not a run that
	// obeys rules the pull request wrote for itself.
	test("and main when there is nothing to go on", () => {
		assert.equal(settingsRef({}, {}), "main")
	})

	test("a head branch in the payload is never used", () => {
		const payload = { repository: { default_branch: "main" }, pull_request: { head: { ref: "attacker" } } }
		assert.equal(settingsRef(payload, {}), "main")
	})
})

describe("the starter file matches the install defaults — FR-13", () => {
	/**
	 * FR-13: "'Test this PR' started by comment, review-before-run, live; every
	 * other binding in preview."
	 *
	 * Live AND gated is the safe pairing, not a contradiction: a gated request
	 * runs in preview to produce its proposal, and only an approved run writes.
	 * Before the gate existed this binding had to be preview, which meant a
	 * repository that copied the starter could never actually write anything.
	 */
	// The whole point of Release 3. `test` runs the project's EXISTING suite
	// and never reads the diff, so a repository copying the starter got "run
	// everything" when it asked Test Companion to test a pull request.
	test("the comment binding runs test-pr, not test", () => {
		const onRequest = STARTER_PIPELINE.split("- name:").find((b) => b.includes("on: pr_comment"))
		assert.match(onRequest, /workflow:\s*test-pr/)
	})

	test("the comment binding is live and gated", () => {
		const onRequest = STARTER_PIPELINE.split("- name:").find((b) => b.includes("on: pr_comment"))
		assert.ok(onRequest, "the starter must bind something to pr_comment")
		assert.match(onRequest, /mode:\s*live/)
		assert.match(onRequest, /approval:\s*review-before-run/)
	})

	test("every other binding stays in preview", () => {
		const others = STARTER_PIPELINE.split("- name:")
			.slice(1)
			.filter((b) => !b.includes("on: pr_comment"))
		assert.ok(others.length > 0)
		for (const b of others) {
			assert.match(b, /mode:\s*preview/)
		}
	})

	test("the setup pull request says what it adds and that nothing runs yet", () => {
		const pr = renderSetupPr("testcompanion-pipeline.yml")
		assert.match(pr.branch, /test-companion/)
		assert.ok(pr.title.length > 0)
		assert.match(pr.body, /testcompanion-pipeline\.yml/)
	})
})

describe("the starter reflects the detected framework — FR-13", () => {
	test("a detected framework is recorded in the file", () => {
		assert.match(starterPipelineFor("Playwright"), /Playwright/)
	})

	test("the bindings are untouched by the note", () => {
		const withFw = starterPipelineFor("Cypress")
		assert.match(withFw, /approval:\s*review-before-run/)
		assert.match(withFw, /on: pr_comment/)
	})

	test("no detection leaves the file exactly as it was", () => {
		assert.equal(starterPipelineFor(undefined), STARTER_PIPELINE)
		assert.equal(starterPipelineFor(""), STARTER_PIPELINE)
	})

	test("the pull request says which framework it saw", () => {
		assert.match(renderSetupPr("p.yml", "Playwright").body, /Playwright/)
	})

	test("and says nothing about it when it saw none", () => {
		assert.ok(!/framework/i.test(renderSetupPr("p.yml").body))
	})
})

describe("the starter workflow points somewhere that exists", () => {
	const starter = readFileSync(new URL("../starter-workflow.yml", import.meta.url), "utf8")

	/**
	 * The starter is the ONE file we can never update: once forty teams have
	 * merged it, changing it costs forty pull requests. So the path in it has
	 * to be right the first time.
	 *
	 * It said `browserstack/test-companion-action@v1` — a repository that does
	 * not exist. The action ships from `browserstack/github-actions`, where the
	 * other BrowserStack actions live, as a sub-directory.
	 */
	test("uses the published action path", () => {
		assert.match(starter, /uses: browserstack\/github-actions\/test-companion@v\d/)
		assert.doesNotMatch(starter, /browserstack\/test-companion-action/)
	})

	/**
	 * Seen live on 2026-10-29: tc 1.1.9 shipped mid-session and every unpinned
	 * run self-upgraded, losing features the Action depends on. An unpinned
	 * customer gets a download in the middle of their pipeline on release day.
	 */
	/**
	 * The test this replaces checked that a version was pinned and said nothing
	 * about the checksum — so it PINNED THE BROKEN STATE. install.sh refuses a
	 * pinned install with no checksum ("refusing an unverified pinned
	 * install"), the step runs under `set -euo pipefail`, and every repository
	 * that copied the starter would have died on its first run with no comment
	 * and no check. Reported in review of PR #3101.
	 *
	 * The rule is a PAIR: an ACTIVE `cli-version:` requires an active
	 * `cli-sha256:`. Commented-out guidance is fine and is how the starter now
	 * presents it, since a checksum cannot be written for a version that does
	 * not exist yet.
	 */
	const activeLines = starter
		.split("\n")
		.filter((l) => !l.trim().startsWith("#"))
		.join("\n")

	test("an active cli-version is never alone — install.sh refuses that pair", () => {
		const pinned = /^\s*cli-version:/m.test(activeLines)
		const summed = /^\s*cli-sha256:/m.test(activeLines)
		assert.equal(
			pinned,
			summed,
			pinned
				? "cli-version is set with no cli-sha256; install.sh refuses an unverified pinned install and the job dies"
				: "cli-sha256 is set with no cli-version, which does nothing",
		)
	})

	test("pinning is still explained, even when not switched on", () => {
		assert.match(starter, /cli-version/)
		assert.match(starter, /cli-sha256/)
	})
})
