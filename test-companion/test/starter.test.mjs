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

describe("no pipeline file", () => {
	test("the report says plainly that nothing is configured yet", () => {
		const out = renderNoPipelineReport("testcompanion-pipeline.yml")
		assert.match(out, /testcompanion-pipeline\.yml/)
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

	test("every event the starter binds is a real pipeline event", () => {
		const known = new Set(Object.values(TC_EVENTS))
		const bound = [...STARTER_PIPELINE.matchAll(/^\s*on:\s*(\S+)/gm)].map((m) => m[1])
		assert.ok(bound.length > 0, "the starter binds nothing")
		for (const e of bound) assert.ok(known.has(e), `${e} is not a pipeline event`)
	})

	test("the starter starts in preview, so a first run writes nothing", () => {
		assert.match(STARTER_PIPELINE, /mode:\s*preview/)
	})
})

describe("which branch the settings file is read from", () => {
	test("the repository's default branch, not the branch under test", () => {
		assert.equal(settingsRef({ repository: { default_branch: "trunk" } }, {}), "trunk")
	})

	test("falls back to the checkout's own default when the payload carries none", () => {
		assert.equal(settingsRef({}, { GITHUB_DEFAULT_BRANCH: "develop" }), "develop")
	})

	test("and main when there is nothing to go on", () => {
		assert.equal(settingsRef({}, {}), "main")
	})

	test("a head branch in the payload is never used", () => {
		const payload = { repository: { default_branch: "main" }, pull_request: { head: { ref: "attacker" } } }
		assert.equal(settingsRef(payload, {}), "main")
	})
})

describe("the starter file matches the install defaults", () => {
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

describe("the starter reflects the detected framework", () => {
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

	test("uses the published action path", () => {
		assert.match(starter, /uses: browserstack\/github-actions\/test-companion@v\d/)
		assert.doesNotMatch(starter, /browserstack\/test-companion-action/)
	})

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

describe("control events do not queue behind the run they act on", () => {
	const starter = readFileSync(new URL("../starter-workflow.yml", import.meta.url), "utf8")
	const group = starter.slice(starter.indexOf("concurrency:"), starter.indexOf("\njobs:"))

	test("a closed pull request lands in a separate group", () => {
		assert.match(group, /github\.event\.action == 'closed'/)
		assert.match(group, /-control/)
	})

	test("work runs still queue rather than cancel each other", () => {
		// A run in flight has already spent credits; the next one waits.
		assert.match(group, /cancel-in-progress:\s*false/)
	})

	test("the group is still per pull request, so two PRs never share one", () => {
		assert.match(group, /github\.event\.pull_request\.number/)
		assert.match(group, /github\.event\.issue\.number/)
	})
})

describe("a comment that is not for us does not start a job", () => {
	const starter = readFileSync(new URL("../starter-workflow.yml", import.meta.url), "utf8")
	const job = starter.slice(starter.indexOf("jobs:"), starter.indexOf("steps:"))

	test("the job is filtered before any runner starts", () => {
		assert.match(job, /if: >-/)
		assert.match(job, /github\.event_name != 'issue_comment'/)
		assert.match(job, /contains\(github\.event\.comment\.body, '@browserstack'\)/)
	})

	test("a bare approval still gets through — proposals ask for exactly that", () => {
		assert.match(job, /startsWith\(github\.event\.comment\.body, 'go'\)/)
		assert.match(job, /startsWith\(github\.event\.comment\.body, 'approve'\)/)
	})

	test("every other event is untouched, so pushes and schedules still run", () => {
		// The filter opens with the non-comment case for exactly this reason.
		const mentionCheck = job.indexOf("contains(github.event.comment.body, '@browserstack')")
		assert.ok(mentionCheck > 0, "the mention check is in the filter")
		assert.ok(job.indexOf("!= 'issue_comment'") < mentionCheck)
	})
})
