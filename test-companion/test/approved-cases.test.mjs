import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
	approvedSavePlan,
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
import { proposalMarkerFor, renderProposal, findProposal } from "../src/report.mjs"

const BINDING = { workflow: "generate", input: { "save-to-tm": "true", tm_project: "Checkout", tm_folder: "Web" } }

describe("approvedSavePlan: a plain go on a generate plan saves the plan's own cases", () => {
	test("plain go with a destination and a recorded run: exact save", () => {
		assert.deepEqual(approvedSavePlan({ workflow: "generate", replyText: "go", binding: BINDING, runId: "1234567890" }), {
			mode: "exact",
			project: "Checkout",
			folder: "Web",
			runId: "1234567890",
		})
	})

	test("go with edits regenerates, and says it is because of the edits", () => {
		assert.deepEqual(approvedSavePlan({ workflow: "generate", replyText: "@browserstack go, drop T003", binding: BINDING, runId: "1" }), {
			mode: "run",
			edited: true,
		})
	})

	test("a plan with no recorded run is unavailable, never regenerated", () => {
		assert.deepEqual(approvedSavePlan({ workflow: "generate", replyText: "go", binding: BINDING, runId: undefined }), {
			mode: "unavailable",
			reason: "no-run",
		})
		assert.equal(approvedSavePlan({ workflow: "generate", replyText: "go", binding: BINDING, runId: "12; rm -rf /" }).mode, "unavailable")
	})

	test("other jobs, and generate with nowhere to save, run as before", () => {
		assert.deepEqual(approvedSavePlan({ workflow: "test-pr", replyText: "go", binding: BINDING, runId: "1" }), { mode: "run" })
		assert.deepEqual(approvedSavePlan({ workflow: "generate", replyText: "go", binding: { input: {} }, runId: "1" }), { mode: "run" })
		assert.deepEqual(
			approvedSavePlan({ workflow: "generate", replyText: "go", binding: { input: { ...BINDING.input, "save-to-tm": "false" } }, runId: "1" }),
			{ mode: "run" },
		)
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
		assert.match(main, /"tm", "add", "--from-file", casesFile, "--project", save\.project, "--folder", save\.folder, "--json"/)
		assert.match(main, /if \(save\.mode === "exact" \|\| save\.mode === "unavailable"\) saveApprovedCases\(plan, save, approvalNote\)/)
	})

	test("action.yml uploads the cases artifact, and a plan's report and result too", () => {
		assert.match(action, /name: test-companion-cases\n\s+path: \$\{\{ steps\.run\.outputs\.cases-dir \}\}/)
		const proposing = main.slice(main.indexOf("if (proposing && !runDidNotWork(outcome))"), main.indexOf('setOutput("outcome", "Proposed")'))
		assert.match(proposing, /setOutput\("result-file", RESULT_FILE\)/)
		assert.match(proposing, /setOutput\("summary-file", SUMMARY_FILE\)/)
	})
})
