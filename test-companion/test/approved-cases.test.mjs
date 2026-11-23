import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
	approvedSavePlan,
	readCasesDestination,
	pickCasesArtifact,
	casesSubject,
	checkCasesSubject,
	parseTmAddReport,
	renderCasesUnavailable,
	renderExactSave,
	exactSaveSummary,
	exactSaveOutcome,
	cliVersionOf,
	cliRecordsDestination,
	missingDestinationReason,
	CASES_DESTINATION_CLI,
	renderPlannedCases,
	casesDigest,
	unshownFields,
	RENDERED_CASE_FIELDS,
	CASES_ARTIFACT,
	browserstackLink,
	renderSaveInterrupted,
	tmAddSavedNothing,
	tmAddStop,
} from "../src/approved-cases.mjs"
import { OUTCOMES } from "../src/outcome.mjs"
import { isApprovalOnly } from "../src/intent.mjs"
import { proposalMarkerFor, renderProposal, findProposal } from "../src/report.mjs"

// `tc workflow bindings --json`, as the CLI really prints it: no `input`, so a binding can't say
// where cases go. The destination is in the plan's cases file instead.
const REAL_BINDINGS = JSON.parse(
	'{"settings":{"ask_team":"","platform":"auto","tests_repo":"","tests_path":"","targets":[],"wcag":"","fail_on_new":false,"visual":false},' +
		'"bindings":[{"name":"generate-on-comment","workflow":"generate","on":"pr_comment","mode":"live","approval":"review-before-run","enabled":true}]}',
)
const GENERATE_BINDING = REAL_BINDINGS.bindings[0]
// The sha256 of the cases file a plan showed, as its marker records it.
const DIGEST = "d".repeat(64)

// A generate preview's result.md.json, shaped like the CLI's.
const CASES_FILE = {
	version: 1,
	workflow: "generate",
	preview: true,
	generated: 1,
	savedToTestManagement: 0,
	note: "None reached Test Management — this was a preview run.",
	cases: [
		{
			id: "T001",
			title: "First retry uses the base delay",
			description: "The first attempt waits exactly the base delay.",
			preconditions: "The helper is importable.",
			steps: [{ step: "Call the helper with attempt 1", result: "Returns the base delay" }],
			priority: "high",
			type: "functional",
		},
	],
}
const withDestination = { ...CASES_FILE, destination: { project: "Checkout", folder: "Web / Cart" } }

describe("approvedSavePlan: a plain go on a generate plan saves the plan's own cases", () => {
	test("reproduces the live failure: real binding shape, plain go, run id present → exact, not run", () => {
		assert.equal("input" in GENERATE_BINDING, false)
		assert.deepEqual(
			approvedSavePlan({ workflow: GENERATE_BINDING.workflow, replyText: "go", binding: GENERATE_BINDING, runId: "1234567890", casesSha256: DIGEST }),
			{ mode: "exact", runId: "1234567890", casesSha256: DIGEST },
		)
	})

	test("go with edits regenerates, and says it is because of the edits", () => {
		assert.deepEqual(approvedSavePlan({ workflow: "generate", replyText: "@browserstack go, drop T003", runId: "1" }), {
			mode: "run",
			edited: true,
		})
	})

	test("a plan with no recorded run is unavailable, never regenerated", () => {
		assert.deepEqual(approvedSavePlan({ workflow: "generate", replyText: "go", runId: undefined }), { mode: "unavailable", reason: "no-run" })
		assert.equal(approvedSavePlan({ workflow: "generate", replyText: "go", runId: "12; rm -rf /" }).mode, "unavailable")
	})

	test("other jobs run as before", () => {
		assert.deepEqual(approvedSavePlan({ workflow: "test-pr", replyText: "go", runId: "1" }), { mode: "run" })
		assert.deepEqual(approvedSavePlan({ workflow: "fix", replyText: "go", runId: "1" }), { mode: "run" })
	})

	test("safety rule: a plain go on a generate plan with a run id never becomes a new generate run", () => {
		// The reply as the Action passes it: the @browserstack mention is already stripped
		// (plan-run.mjs), so "@browserstack go" arrives as "go".
		const plainGoes = ["go", "Go", "GO", "go!", "go.", " go ", "go #123456"]
		const bindings = [GENERATE_BINDING, undefined, {}, { input: {} }, { input: { "save-to-tm": "false" } }]
		for (const replyText of plainGoes) {
			assert.equal(isApprovalOnly(replyText), true, `"${replyText}" should be a plain approval`)
			for (const binding of bindings) {
				assert.equal(
					approvedSavePlan({ workflow: "generate", replyText, binding, runId: "77", casesSha256: DIGEST }).mode,
					"exact",
					`"${replyText}" with ${JSON.stringify(binding)}`,
				)
				// Without the cases' fingerprint it is refused, still never a new generate run.
				assert.equal(approvedSavePlan({ workflow: "generate", replyText, binding, runId: "77" }).mode, "unavailable")
			}
		}
	})
})

describe("readCasesDestination: where the cases go comes from the approved file", () => {
	test("the file's destination", () => {
		assert.deepEqual(readCasesDestination(JSON.stringify(withDestination)), { project: "Checkout", folder: "Web / Cart" })
	})
	test("no destination (none configured, or an older CLI): nowhere to save", () => {
		assert.deepEqual(readCasesDestination(JSON.stringify(CASES_FILE)), { error: "no-destination" })
		assert.deepEqual(readCasesDestination(JSON.stringify({ ...CASES_FILE, destination: { project: "Checkout" } })), { error: "no-destination" })
	})
	test("not a cases file: unreadable", () => {
		assert.deepEqual(readCasesDestination("not json"), { error: "unreadable" })
		assert.deepEqual(readCasesDestination(JSON.stringify({ destination: withDestination.destination })), { error: "unreadable" })
		assert.deepEqual(readCasesDestination(undefined), { error: "unreadable" })
	})
	test("no destination says so, saves nothing and does not regenerate", () => {
		const text = renderCasesUnavailable("no-destination")
		assert.match(text, /I did not save anything: the plan recorded no Test Management destination/)
		assert.match(text, /I have not generated a new set/)
		assert.match(text, /`tm_project` and `tm_folder`/)
	})
})

describe("pickCasesArtifact", () => {
	const run = { id: 7, repository_id: 42, head_repository_id: 42, head_sha: "def" }
	const art = (over) => ({ name: CASES_ARTIFACT, expired: false, workflow_run: run, id: 1, ...over })
	const opts = { repoId: "42" }

	test("the plan run's live cases artifact", () => {
		assert.deepEqual(pickCasesArtifact({ artifacts: [art({ name: "test-companion-report" }), art()] }, "7", opts), { artifact: art() })
	})
	test("none from that run is missing; only expired ones is expired", () => {
		assert.deepEqual(pickCasesArtifact({ artifacts: [art({ workflow_run: { ...run, id: 8 } })] }, "7", opts), { error: "missing" })
		assert.deepEqual(pickCasesArtifact({ artifacts: [art({ expired: true })] }, "7", opts), { error: "expired" })
		assert.deepEqual(pickCasesArtifact(null, "7", opts), { error: "missing" })
	})
	test("a run from another repository, or started from a fork, is refused", () => {
		assert.deepEqual(pickCasesArtifact({ artifacts: [art({ workflow_run: { ...run, repository_id: 9 } })] }, "7", opts), { error: "other-repo" })
		assert.deepEqual(pickCasesArtifact({ artifacts: [art({ workflow_run: { ...run, head_repository_id: 9 } })] }, "7", opts), { error: "other-repo" })
	})
	test("fails closed when either side doesn't say which repository", () => {
		assert.deepEqual(pickCasesArtifact({ artifacts: [art()] }, "7", {}), { error: "other-repo" })
		assert.deepEqual(pickCasesArtifact({ artifacts: [art({ workflow_run: { id: 7 } })] }, "7", opts), { error: "other-repo" })
	})
	test("the run's commit is not compared: a plan asked for in a comment runs on the default branch", () => {
		assert.ok(pickCasesArtifact({ artifacts: [art({ workflow_run: { ...run, head_sha: "anything" } })] }, "7", opts).artifact)
	})
})

describe("checkCasesSubject: the saved cases must be for this repo and this plan's commit", () => {
	const subject = JSON.stringify(casesSubject({ repo: "o/r", sha: "abc123" }))
	test("same repo and commit", () => {
		assert.deepEqual(checkCasesSubject(subject, { repo: "o/r", sha: "abc123" }), { ok: true, cli: "" })
	})
	test("another repo, another commit, or junk is refused", () => {
		assert.deepEqual(checkCasesSubject(subject, { repo: "o/other", sha: "abc123" }), { ok: false, why: "other-repo" })
		assert.deepEqual(checkCasesSubject(subject, { repo: "o/r", sha: "def456" }), { ok: false, why: "other-commit" })
		assert.deepEqual(checkCasesSubject("not json", { repo: "o/r", sha: "abc123" }), { ok: false, why: "unreadable" })
		assert.deepEqual(checkCasesSubject(undefined, { repo: "o/r", sha: "abc123" }), { ok: false, why: "unreadable" })
	})
})

describe("parseTmAddReport reads tc tm add --json", () => {
	const report = {
		project: "PR-1",
		folderId: "4242",
		created: [{ sourceId: "T001", title: "Base delay", identifier: "TC-1", url: "https://tm.example/TC-1" }],
		failed: [],
	}
	test("the report object, with missing lists filled in", () => {
		assert.deepEqual(parseTmAddReport(JSON.stringify(report, null, 2)), { ...report, skipped: [] })
	})
	test("the last object when something was printed before it", () => {
		assert.equal(parseTmAddReport(`Saving 1 case…\n${JSON.stringify(report)}`)?.created.length, 1)
	})
	test("no report means it stopped before saving", () => {
		assert.equal(parseTmAddReport(""), undefined)
		assert.equal(parseTmAddReport("Error: project not found"), undefined)
		assert.equal(parseTmAddReport('{"error":"x"}'), undefined)
	})
})

describe("what the reply says", () => {
	const where = { project: "Checkout", folder: "Web" }
	const created = [
		{ title: "Base delay", identifier: "TC-1", url: "https://test-management.browserstack.com/projects/1/test-cases/TC-1" },
		{ title: "Cap", identifier: "TC-2" },
	]

	test("every saved case is listed with its id, from tm add's own output", () => {
		const text = renderExactSave({ created, failed: [], skipped: [] }, where)
		assert.match(text, /Saved the 2 approved test cases to Web in Checkout exactly as planned; nothing was generated again\./)
		assert.match(text, /- \[TC-1\]\(<https:\/\/test-management\.browserstack\.com\/projects\/1\/test-cases\/TC-1>\) — Base delay/)
		assert.match(text, /- TC-2 — Cap/)
	})

	test("a partial save names what failed", () => {
		const text = renderExactSave({ created: created.slice(0, 1), failed: [{ title: "Cap", error: "priority not allowed" }], skipped: [] }, where)
		assert.match(text, /Saved the 1 approved test case to/)
		assert.match(text, /\*\*1 could not be saved:\*\*\n\n- Cap: priority not allowed/)
	})

	test("the table counts agree with the list", () => {
		assert.deepEqual(exactSaveSummary({ created, failed: [{ title: "x", error: "y" }], skipped: [] }, where), {
			workflow: "generate",
			event: "pr_comment",
			cases_generated: "3",
			cases_saved: "2",
			saved_to: "Web in Checkout",
		})
	})

	test("unavailable says why, saves nothing and does not regenerate", () => {
		const text = renderCasesUnavailable("expired")
		assert.match(text, /I did not save anything: the plan's saved cases have expired\./)
		assert.match(text, /I have not generated a new set/)
		assert.match(renderCasesUnavailable("save-failed", "folder not found"), /before any case was saved \(folder not found\)\./)
	})
})

describe("exactSaveOutcome: once anything is saved the plan is spent", () => {
	test("all saved: succeeded and spent", () => {
		assert.deepEqual(exactSaveOutcome({ created: [{}], failed: [], skipped: [] }, OUTCOMES), { outcome: OUTCOMES.SUCCEEDED, spend: true })
	})
	test("some saved, some failed: broke, but spent so approving again can't save them twice", () => {
		assert.deepEqual(exactSaveOutcome({ created: [{}], failed: [{}], skipped: [] }, OUTCOMES), { outcome: OUTCOMES.RUN_BROKE, spend: true })
	})
	test("none saved: broke and still approvable", () => {
		assert.deepEqual(exactSaveOutcome({ created: [], failed: [{}], skipped: [] }, OUTCOMES), { outcome: OUTCOMES.RUN_BROKE, spend: false })
	})
})

describe("the plan records the run that made it", () => {
	test("the marker carries the run id, and findProposal reads it back", () => {
		const body = renderProposal("plan", "abc123", "octocat", "generate", "1234567890")
		assert.match(body, /<!-- test-companion-proposal sha=abc123 by=octocat workflow=generate run=1234567890 -->/)
		const found = findProposal([{ id: 5, user: { type: "Bot", login: "bot[bot]" }, body, created_at: new Date().toISOString() }], "abc123", Date.now(), "bot[bot]")
		assert.equal(found?.runId, "1234567890")
		assert.equal(found?.workflow, "generate")
	})
	test("a non-numeric run id is left out; old markers still read", () => {
		assert.equal(proposalMarkerFor("abc", "o", "generate", "x y"), "<!-- test-companion-proposal sha=abc by=o workflow=generate -->")
		const old = "plan\n<!-- test-companion-proposal sha=abc by=o workflow=generate -->"
		const found = findProposal([{ id: 1, user: { type: "Bot", login: "b" }, body: old, created_at: new Date().toISOString() }], "abc", Date.now(), "b")
		assert.equal(found?.runId, undefined)
		assert.equal(found?.workflow, "generate")
	})
})

describe("the wiring", () => {
	const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")
	const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8")

	test("a plan attaches its cases, and approving one saves them with tm add instead of running again", () => {
		assert.match(main, /setOutput\("cases-dir", CASES_DIR\)/)
		assert.match(main, /env\.GITHUB_RUN_ID,\n[^\n]*\n\s*\{ build: buildRunId, cases: casesSha256, shown: casesShown \},\n\s*\),\n\s*\)/)
		// No --project/--folder: tm add takes the destination from the approved file.
		assert.match(main, /\["tm", "add", "--from-file", casesFile, "--json"\]/)
		assert.doesNotMatch(main, /binding\?\.input|\.input\?\.tm_/)
	})

	test("safety rule in the wiring: an exact or unavailable go always ends the run", () => {
		assert.match(
			main,
			/if \(save\.mode === "exact" \|\| save\.mode === "unavailable"\) \{\n\s*saveApprovedCases\(plan, save, approvalNote\)\n[^\n]*\n\s*process\.exit\(0\)\n\s*\}/,
		)
		const fn = main.slice(main.indexOf("function saveApprovedCases("), main.indexOf("function saveExactly("))
		assert.match(fn, /try \{\n\s*saveExactly\(/)
		assert.match(fn, /catch \(e\) \{\n\s*unavailable\("save-failed"/)
		assert.match(fn, /process\.exit\(0\)/)
	})

	test("action.yml uploads the cases artifact, and a plan's report and result too", () => {
		assert.match(action, /name: test-companion-cases\n\s+path: \$\{\{ steps\.run\.outputs\.cases-dir \}\}/)
		const proposing = main.slice(main.indexOf("if (proposing && !runDidNotWork(outcome))"), main.indexOf('setOutput("outcome", "Proposed")'))
		assert.match(proposing, /setOutput\("result-file", RESULT_FILE\)/)
		assert.match(proposing, /setOutput\("summary-file", SUMMARY_FILE\)/)
	})
})

describe("approving saves exactly the cases the plan showed", () => {
	const file = Buffer.from(
		JSON.stringify({
			destination: { project: "rag_assignment", folder: "github-app", projectId: "PR-42", folderId: "7" },
			cases: [
				{ id: "T001", title: "Base delay", priority: "high", preconditions: "Module importable", steps: [{ step: "Call f(1)", result: "500" }] },
				{ id: "T002", title: "Ping @octocat [here](https://evil.test)", steps: [] },
			],
		}),
	)

	test("the plan is shown from the cases file, with where it will be saved", () => {
		const shown = renderPlannedCases(file)
		assert.ok(shown.body.includes('**Will be saved to:** [github-app in rag\\_assignment](https://test-management.browserstack.com/projects/PR-42/folder/7), once approved.'))
		assert.match(shown.body, /\*\*2 test cases:\*\*/)
		assert.match(shown.body, /<details><summary>T001 — Base delay<\/summary>/)
		assert.match(shown.body, /\*\*Priority:\*\* high/)
		assert.match(shown.body, /\*\*Before you start:\*\* Module importable/)
		assert.match(shown.body, /1\. Call f\\\(1\\\)\n {3}- Expected: 500/)
		assert.equal(shown.digest, casesDigest(file))
	})

	test("agent-written text can't mention anyone or add a link", () => {
		const shown = renderPlannedCases(file).body
		assert.doesNotMatch(shown, /@octocat/)
		// The only link is the destination folder, built from its ids.
		const ours = "](https://test-management.browserstack.com/projects/PR-42/folder/7)"
		assert.doesNotMatch(shown.replace(ours, ""), /\]\(https:\/\//)
		assert.doesNotMatch(shown, /https:\/\/evil/)
	})

	test("one changed byte changes the fingerprint", () => {
		const changed = Buffer.from(file.toString("utf8").replace("Base delay", "Base delaz"))
		assert.notEqual(casesDigest(changed), renderPlannedCases(file).digest)
	})

	test("a file with no destination says approving can't save it", () => {
		const none = Buffer.from(JSON.stringify({ cases: [{ id: "T001", title: "x" }] }))
		assert.match(renderPlannedCases(none).body, /Will be saved to:\*\* nowhere/)
	})

	test("an unreadable file shows no generated plan", () => {
		assert.equal(renderPlannedCases(Buffer.from("not json")), undefined)
		assert.equal(renderPlannedCases(Buffer.from("{}")), undefined)
	})

	test("the fingerprint travels in our plan comment", () => {
		const digest = casesDigest(file)
		const body = renderProposal("plan", "abc123", "octocat", "generate", "1234567890", { cases: digest })
		const waiting = findProposal([{ id: 5, user: { login: "browserstack[bot]", type: "Bot" }, created_at: new Date().toISOString(), body }], "abc123", Date.now(), "browserstack[bot]")
		assert.equal(waiting.casesSha256, digest)
		assert.deepEqual(approvedSavePlan({ workflow: "generate", replyText: "go", runId: waiting.runId, casesSha256: waiting.casesSha256 }), {
			mode: "exact",
			runId: "1234567890",
			casesSha256: digest,
		})
	})

	test("a plan without the fingerprint is refused, with a reason", () => {
		assert.deepEqual(approvedSavePlan({ workflow: "generate", replyText: "go", runId: "1" }), { mode: "unavailable", reason: "no-digest" })
		assert.match(renderCasesUnavailable("no-digest"), /didn't record which cases it showed/)
		assert.match(renderCasesUnavailable("changed"), /not the ones this plan showed/)
	})

	test("the wiring checks the fingerprint before tm add, and shows a generate plan from the file", () => {
		const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")
		const fn = main.slice(main.indexOf("function saveExactly("), main.indexOf("function pickBinding("))
		const check = fn.indexOf('casesDigest(bytes) !== save.casesSha256) return unavailable("changed")')
		assert.ok(check > 0, "no fingerprint check")
		assert.ok(check < fn.indexOf('"tm", "add"'), "the check must come before tm add")
		assert.match(main, /renderPlannedCases\(casesBytes, \{ maxChars: COMMENT_LIMIT - summaryShown\.length/)
		assert.match(main, /readBytes\(join\(CASES_DIR, CASES_DATA_FILE\)\)/)
	})
})

describe("an older CLI is named as the problem, not the pipeline file", () => {
	test("reads the version from the `tc --version` line", () => {
		assert.deepEqual(cliVersionOf("test-companion CLI v1.1.16 (beta)"), [1, 1, 16])
		assert.equal(cliVersionOf("unknown"), undefined)
		assert.equal(CASES_DESTINATION_CLI, "1.1.16")
	})

	test("which CLIs record a destination", () => {
		assert.equal(cliRecordsDestination("test-companion CLI v1.1.15 (beta)"), false)
		assert.equal(cliRecordsDestination("test-companion CLI v1.0.99"), false)
		assert.equal(cliRecordsDestination("test-companion CLI v1.1.16 (beta)"), true)
		assert.equal(cliRecordsDestination("test-companion CLI v1.2.0"), true)
		assert.equal(cliRecordsDestination("test-companion CLI v2.0.0"), true)
		assert.equal(cliRecordsDestination(""), undefined)
	})

	test("a plan made by an older CLI isn't blamed on the pipeline file", () => {
		assert.equal(missingDestinationReason("test-companion CLI v1.1.15 (beta)"), "old-cli-plan")
		const text = renderCasesUnavailable("old-cli-plan", "test-companion CLI v1.1.15 (beta)")
		assert.match(text, /older than 1\.1\.16/)
		assert.doesNotMatch(text, /Set `tm_project`/)
		assert.match(text, /generate\*\* again/)
	})

	test("with a new enough CLI, a missing destination points at the pipeline file, and mentions the CLI only as a fallback", () => {
		assert.equal(missingDestinationReason("test-companion CLI v1.1.16 (beta)"), "no-destination")
		assert.equal(missingDestinationReason(""), "no-destination")
		const text = renderCasesUnavailable("no-destination")
		assert.match(text, /Set `tm_project` and `tm_folder`/)
		assert.match(text, /If they are already set, the plan was probably made with a CLI older than 1\.1\.16/)
	})

	test("a go run whose CLI can't save from a file says so, and the plan stays approvable", () => {
		const text = renderCasesUnavailable("old-cli", "test-companion CLI v1.1.14")
		assert.match(text, /needs Test Companion CLI 1\.1\.16 or later/)
		assert.match(text, /reply \*\*go\*\* to this plan again; it is still waiting/)
		assert.doesNotMatch(text, /refused/)
	})

	test("the plan records its CLI, and the go run checks its own before anything else", () => {
		const subject = JSON.stringify(casesSubject({ repo: "o/r", sha: "abc", cli: "test-companion CLI v1.1.15 (beta)" }))
		assert.equal(checkCasesSubject(subject, { repo: "o/r", sha: "abc" }).cli, "test-companion CLI v1.1.15 (beta)")
		const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")
		const fn = main.slice(main.indexOf("function saveExactly("), main.indexOf("function pickBinding("))
		assert.ok(fn.indexOf("cliHasTmAddFromFile()") < fn.indexOf("pickCasesArtifact("), "the CLI check comes first")
		assert.match(fn, /missingDestinationReason\(subject\.cli\)/)
		const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8")
		const runStep = action.slice(action.indexOf("- name: Run\n"), action.indexOf("- name: Attach the report"))
		assert.match(runStep, /TC_ACTION_CLI_VERSION: \$\{\{ steps\.install\.outputs\.cli-version \}\}/)
	})
})

describe("the exact-save reply can't be used to mention people or plant links", () => {
	test("only https BrowserStack addresses are linked", () => {
		assert.ok(browserstackLink("https://test-management.browserstack.com/projects/1"))
		assert.ok(browserstackLink("https://browserstack.com/x"))
		for (const u of ["https://evil.test/x", "http://browserstack.com/x", "https://browserstack.com.evil.test/", "https://u@browserstack.com/", "javascript:alert(1)", ""]) {
			assert.equal(browserstackLink(u), undefined, u)
		}
	})

	test("titles, ids and errors are plain text", () => {
		const text = renderExactSave(
			{
				created: [{ identifier: "TC-1", title: "Ping @octocat [here](https://evil.test)", url: "https://evil.test/TC-1" }],
				failed: [{ title: "**bold**", error: "see <img src=x>" }],
				skipped: [],
			},
			{ project: "P", folder: "F" },
		)
		assert.doesNotMatch(text, /@octocat/)
		assert.doesNotMatch(text, /\]\(https:\/\/evil/)
		assert.doesNotMatch(text, /\(<https:\/\/evil/)
		assert.match(text, /- TC-1 — /, "a non-BrowserStack URL is not linked")
		assert.doesNotMatch(text, /(^|[^\\])<img/, "an unescaped HTML tag")
		assert.doesNotMatch(text, /- \*\*bold\*\*/)
	})
})

describe("a save that stopped without a report uses the plan up", () => {
	test("only the CLI's own 'nothing was saved' keeps the plan approvable", () => {
		assert.equal(tmAddSavedNothing("Error: nothing was saved: case T003 has no title"), true)
		assert.equal(tmAddSavedNothing("signal: killed"), false)
		assert.equal(tmAddSavedNothing(""), false)
	})

	test("the reply says some may be saved, and to check before asking again", () => {
		const text = renderSaveInterrupted({ project: "rag", folder: "github-app" }, "stopped by SIGTERM")
		assert.match(text, /some of the approved cases may already be in github-app in rag/)
		assert.match(text, /used up/)
		assert.match(text, /Check github-app in rag before asking me to \*\*generate\*\* again/)
	})

	test("the wiring: killed, timed out or no report is a used-up Run broke; only 'nothing was saved' stays approvable", () => {
		const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")
		const fn = main.slice(main.indexOf("function saveExactly("), main.indexOf("function pickBinding("))
		assert.match(fn, /if \(tmAddStop\(\{ status: r\.status, signal: r\.signal, errorCode: r\.error\?\.code, stderr \}\) === "nothing-saved"\) \{\n\s*return unavailable\("save-failed", why, download\)/)
		assert.match(fn, /return finish\(\{ \.\.\.base, outcome: OUTCOMES\.RUN_BROKE, answer: renderSaveInterrupted\(where, why\) \}, true\)/)
	})
})

describe("failure detail is kept, and kept out of the comment", () => {
	test("a failed artifact lookup is reported as a lookup failure, and the plan stays approvable", () => {
		const text = renderCasesUnavailable("lookup-failed")
		assert.match(text, /couldn't look up the plan's saved cases/)
		assert.match(text, /it is still waiting/)
		const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")
		const fn = main.slice(main.indexOf("function saveExactly("), main.indexOf("function pickBinding("))
		assert.match(fn, /if \(lookup\.failed\) return unavailable\("lookup-failed"\)/)
		assert.match(fn, /pickCasesArtifact\(lookup\.found, save\.runId, \{ repoId: env\.GITHUB_REPOSITORY_ID \}\)/)
	})

	test("download and tm add errors go to the job log with secrets hidden, not the comment", () => {
		const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")
		const log = main.slice(main.indexOf("function logRedacted("), main.indexOf("function readBytes("))
		assert.match(log, /redactSecrets\(/)
		assert.match(log, /console\.log\(/)
		assert.doesNotMatch(log, /replyOnPr|postComment/)
		const fn = main.slice(main.indexOf("function saveExactly("), main.indexOf("function pickBinding("))
		assert.match(fn, /logRedacted\("gh run download", got\.stderr\)/)
		assert.match(fn, /logRedacted\("tc tm add", stderr \|\| r\.error\?\.message\)/)
	})
})

describe("the plan shows every field approving saves", () => {
	const doc = (cases, extra = {}) => Buffer.from(JSON.stringify({ destination: { project: "rag", folder: "gh" }, cases, ...extra }))

	test("a BDD case shows its feature, background and scenario", () => {
		const shown = renderPlannedCases(
			doc([
				{
					id: "T001",
					title: "Login works",
					format: "bdd",
					feature: "Login",
					background: "Given the app is open",
					bddScenario: "Scenario: good password\n  When I sign in\n  Then I see my home page",
				},
			]),
		)
		assert.equal(shown.complete, true)
		assert.deepEqual(shown.unshown, [])
		assert.match(shown.body, /\*\*Format:\*\* BDD/)
		assert.match(shown.body, /\*\*Feature:\*\* Login/)
		assert.match(shown.body, /\*\*Background:\*\* Given the app is open/)
		assert.match(shown.body, /\*\*Scenario:\*\*\n\n```text\nScenario: good password\n {2}When I sign in\n {2}Then I see my home page\n```/)
	})

	test("description, type, tags, references and custom fields are all shown, as plain text", () => {
		const shown = renderPlannedCases(
			doc([
				{
					id: "T002",
					title: "Cap",
					description: "Checks the cap\nSee @octocat",
					type: "Functional",
					tags: ["smoke", "retry"],
					references: ["https://evil.test/x", "ISSUE-1"],
					customFields: { Team: "QA", Owner: "@mallory" },
				},
			]),
		)
		assert.deepEqual(shown.unshown, [])
		assert.match(shown.body, /\*\*Description:\*\*\n\n```text\nChecks the cap\nSee @octocat\n```/, "in a code block: no mention")
		assert.match(shown.body, /\*\*Type:\*\* Functional/)
		assert.match(shown.body, /\*\*Tags:\*\* smoke, retry/)
		assert.match(shown.body, /- https:\u200b\/\/evil\.test\/x/, "a reference is not a link")
		assert.match(shown.body, /- ISSUE-1/)
		assert.match(shown.body, /- Team: QA/)
		assert.match(shown.body, /- Owner: @\u200bmallory/)
	})

	test("a case already in Test Management is labelled, since saving skips it", () => {
		assert.match(renderPlannedCases(doc([{ id: "TC-9", title: "Old", folder: "F-1" }])).body, /Already in Test Management \(F-1\): saving skips this case/)
	})

	test("an unknown field is listed in the plan, and refused before saving", () => {
		const shown = renderPlannedCases(doc([{ id: "T003", title: "x", links: ["https://evil.test"] }]))
		assert.deepEqual(shown.unshown, ["T003: links"])
		assert.match(shown.body, /can't save its cases exactly as shown/)
		const text = renderCasesUnavailable("unshown", "T003: links")
		assert.match(text, /fields the plan couldn't show/)
		const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")
		const fn = main.slice(main.indexOf("function saveExactly("), main.indexOf("function pickBinding("))
		const check = fn.indexOf('if (unshown.length) return unavailable("unshown"')
		assert.ok(check > fn.indexOf("casesDigest(bytes)"), "after the fingerprint check")
		assert.ok(check < fn.indexOf('"tm", "add"'), "before tm add")
	})

	test("a field of the wrong shape counts as not shown", () => {
		assert.deepEqual(unshownFields({ cases: [{ id: "T1", title: "x", tags: "smoke" }] }), ["T1: tags"])
		assert.deepEqual(unshownFields({ cases: [{ id: "T1", title: "x", customFields: { a: { nested: 1 } } }] }), ["T1: customFields"])
		assert.deepEqual(unshownFields({ cases: [{ id: "T1", title: "x", steps: [{ step: "s", note: "hidden" }] }] }), ["T1: steps"])
		assert.deepEqual(unshownFields({ cases: ["not a case"] }), ["#1: not a test case"])
	})

	test("an empty unknown field doesn't block", () => {
		assert.deepEqual(unshownFields({ cases: [{ id: "T1", title: "x", links: [], extra: "", other: null }] }), [])
	})

	test("the renderer and the check share one list of fields", () => {
		const full = {
			id: "T1",
			title: "t",
			folder: "F",
			format: "bdd",
			type: "ty",
			priority: "p",
			tags: ["tg"],
			description: "de",
			preconditions: "pr",
			feature: "fe",
			background: "bg",
			bddScenario: "sc",
			steps: [{ step: "st", result: "re" }],
			references: ["rf"],
			customFields: { k: "v" },
		}
		assert.deepEqual(Object.keys(full).sort(), [...RENDERED_CASE_FIELDS].sort(), "the list is exactly these fields")
		assert.deepEqual(unshownFields({ cases: [full] }), [])
		const body = renderPlannedCases(doc([full])).body
		for (const value of ["T1", "t", "F", "BDD", "ty", "p", "tg", "de", "pr", "fe", "bg", "sc", "st", "re", "rf", "k: v"]) {
			assert.ok(body.includes(value), `${value} is not shown`)
		}
		for (const key of RENDERED_CASE_FIELDS) {
			assert.deepEqual(unshownFields({ cases: [{ title: "x", [key + "X"]: "v" }] }), [`#1: ${key}X`])
		}
	})

	test("a plan too large for one comment shows what fits, says so, and can't be approved", () => {
		const cases = Array.from({ length: 300 }, (_, i) => ({ id: `T${i}`, title: `case ${i}`, steps: [{ step: "s".repeat(300), result: "r" }] }))
		const shown = renderPlannedCases(doc(cases), { maxChars: 20_000 })
		assert.equal(shown.complete, false)
		assert.ok(shown.body.length <= 20_000, String(shown.body.length))
		assert.match(shown.body, /too large to show in full/)
		assert.match(shown.body, /can't be approved to save exactly as shown/)
		const marker = proposalMarkerFor("abc", "o", "generate", "1", { cases: shown.digest, shown: "partial" })
		assert.match(marker, / shown=partial -->$/)
		const waiting = findProposal(
			[{ id: 5, user: { login: "browserstack[bot]", type: "Bot" }, created_at: new Date().toISOString(), body: `p\n\n${marker}` }],
			"abc",
			Date.now(),
			"browserstack[bot]",
		)
		assert.equal(waiting.casesShown, "partial")
		assert.deepEqual(
			approvedSavePlan({ workflow: "generate", replyText: "go", runId: "1", casesSha256: shown.digest, casesShown: waiting.casesShown }),
			{ mode: "unavailable", reason: "partial" },
		)
		assert.match(renderCasesUnavailable("partial"), /too large to show every case/)
	})

	test("a plan shown from the agent's text can't be approved for an exact save, and says why", () => {
		assert.deepEqual(approvedSavePlan({ workflow: "generate", replyText: "go", runId: "1", casesShown: "markdown" }), {
			mode: "unavailable",
			reason: "unchecked",
		})
		const text = renderCasesUnavailable("unchecked")
		assert.match(text, /couldn't be shown from its cases file/)
		assert.doesNotMatch(text, /older version/)
		const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")
		assert.match(main, /if \(isGenerate\) casesShown = "markdown"/)
	})
})

describe("a save that stopped says nothing was saved only when that's certain", () => {
	test("failing before saving (sign-in, connection, finding the folder) means nothing was saved", () => {
		assert.equal(tmAddStop({ status: 1, stderr: "Error: not signed in" }), "nothing-saved")
		assert.equal(tmAddStop({ status: 1, stderr: "Error: folder \"x\" not found in project PR-1" }), "nothing-saved")
		assert.equal(tmAddStop({ status: 1, stderr: "Error: nothing was saved: this file records no Test Management destination" }), "nothing-saved")
	})

	test("a CLI that never started saved nothing", () => {
		assert.equal(tmAddStop({ status: null, errorCode: "ENOENT" }), "nothing-saved")
	})

	test("a kill, a timeout, a crash or a clean exit with no report may have saved some", () => {
		assert.equal(tmAddStop({ status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" }), "uncertain")
		assert.equal(tmAddStop({ status: null, signal: "SIGKILL" }), "uncertain")
		assert.equal(tmAddStop({ status: 2, stderr: "panic: runtime error\n\ngoroutine 1 [running]:" }), "uncertain")
		assert.equal(tmAddStop({ status: 0, stderr: "" }), "uncertain")
	})

	test("the wording matches", () => {
		assert.match(renderCasesUnavailable("save-failed", "not signed in"), /the save stopped before any case was saved \(not signed in\)/)
		assert.doesNotMatch(renderCasesUnavailable("save-failed"), /may already/)
		assert.match(renderSaveInterrupted({ project: "p", folder: "f" }, "stopped by SIGTERM"), /may already be in f in p/)
	})
})
