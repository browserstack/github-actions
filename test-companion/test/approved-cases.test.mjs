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
	CASES_ARTIFACT,
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
		assert.deepEqual(approvedSavePlan({ workflow: GENERATE_BINDING.workflow, replyText: "go", binding: GENERATE_BINDING, runId: "1234567890" }), {
			mode: "exact",
			runId: "1234567890",
		})
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
				assert.equal(approvedSavePlan({ workflow: "generate", replyText, binding, runId: "77" }).mode, "exact", `"${replyText}" with ${JSON.stringify(binding)}`)
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
	const art = (over) => ({ name: CASES_ARTIFACT, expired: false, workflow_run: { id: 7 }, id: 1, ...over })

	test("the plan run's live cases artifact", () => {
		assert.deepEqual(pickCasesArtifact({ artifacts: [art({ name: "test-companion-report" }), art()] }, "7"), { artifact: art() })
	})
	test("none from that run is missing; only expired ones is expired", () => {
		assert.deepEqual(pickCasesArtifact({ artifacts: [art({ workflow_run: { id: 8 } })] }, "7"), { error: "missing" })
		assert.deepEqual(pickCasesArtifact({ artifacts: [art({ expired: true })] }, "7"), { error: "expired" })
		assert.deepEqual(pickCasesArtifact(null, "7"), { error: "missing" })
	})
})

describe("checkCasesSubject: the saved cases must be for this repo and this plan's commit", () => {
	const subject = JSON.stringify(casesSubject({ repo: "o/r", sha: "abc123" }))
	test("same repo and commit", () => {
		assert.deepEqual(checkCasesSubject(subject, { repo: "o/r", sha: "abc123" }), { ok: true })
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
		{ title: "Base delay", identifier: "TC-1", url: "https://tm.example/TC-1" },
		{ title: "Cap", identifier: "TC-2" },
	]

	test("every saved case is listed with its id, from tm add's own output", () => {
		const text = renderExactSave({ created, failed: [], skipped: [] }, where)
		assert.match(text, /Saved the 2 approved test cases to `Web in Checkout` exactly as planned; nothing was generated again\./)
		assert.match(text, /- \[TC-1\]\(https:\/\/tm\.example\/TC-1\) — Base delay/)
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
		assert.match(renderCasesUnavailable("save-failed", "folder not found"), /before any were saved \(folder not found\)\./)
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
		assert.match(main, /env\.GITHUB_RUN_ID,\n\s*\),\n\s*\)/)
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
