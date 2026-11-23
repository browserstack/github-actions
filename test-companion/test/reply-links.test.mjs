import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { renderJobSummary, renderNextStep, renderProposal, plain } from "../src/report.mjs"
import {
	tmFolderUrl,
	artifactDownloadLink,
	keptUntil,
	parseTmAddReport,
	renderCasesUnavailable,
	renderExactSave,
	renderSaveInterrupted,
} from "../src/approved-cases.mjs"

const FOLDER = "https://test-management.browserstack.com/projects/4328203/folder/61742797/test-cases"
const DOWNLOAD = "https://github.com/o/r/actions/runs/123/artifacts/456"
const RUN = "https://github.com/o/r/actions/runs/999"
const where = { project: "rag_assignment", folder: "github-app" }

describe("tmFolderUrl: only the saved folder's Test Management page is linked", () => {
	test("the page tc tm add reports for that folder is kept", () => {
		assert.equal(tmFolderUrl(FOLDER, "61742797"), FOLDER)
	})
	test("a region's own Test Management host is kept", () => {
		const eu = "https://test-management-eu.browserstack.com/projects/1/folder/2/test-cases"
		assert.equal(tmFolderUrl(eu, "2"), eu)
	})
	test("a page for another folder is not linked", () => {
		assert.equal(tmFolderUrl(FOLDER, "1"), undefined)
		assert.equal(tmFolderUrl(FOLDER, undefined), undefined)
	})
	test("anything else gives no link", () => {
		assert.equal(tmFolderUrl(undefined, "2"), undefined)
		assert.equal(tmFolderUrl("", "2"), undefined)
		assert.equal(tmFolderUrl("https://test-management.browserstack.com/projects/PR-164148/folder/61742797/test-cases", "61742797"), undefined)
		assert.equal(tmFolderUrl("https://evil.test/projects/1/folder/2/test-cases", "2"), undefined)
		assert.equal(tmFolderUrl("https://browserstack.com.evil.test/projects/1/folder/2/test-cases", "2"), undefined)
		assert.equal(tmFolderUrl("http://test-management.browserstack.com/projects/1/folder/2/test-cases", "2"), undefined)
		assert.equal(tmFolderUrl(`${FOLDER}?next=https://evil.test`, "61742797"), undefined)
		assert.equal(tmFolderUrl(`${FOLDER})[x](https://evil.test`, "61742797"), undefined)
		assert.equal(tmFolderUrl(`${FOLDER}\nhttps://evil.test`, "61742797"), undefined)
	})
})

describe("artifactDownloadLink and keptUntil", () => {
	test("repo, run and artifact ids make the link", () => {
		assert.equal(artifactDownloadLink("o/r", "123", 456), DOWNLOAD)
	})
	test("anything else gives no link", () => {
		assert.equal(artifactDownloadLink("o/r", "123", undefined), undefined)
		assert.equal(artifactDownloadLink("o", "123", "456"), undefined)
		assert.equal(artifactDownloadLink("o/r/x", "123", "456"), undefined)
		assert.equal(artifactDownloadLink("o/r", "12a", "456"), undefined)
	})
	test("the artifact's expiry becomes a date, or nothing", () => {
		assert.equal(keptUntil("2026-11-30T10:41:00Z"), "until 2026-11-30")
		assert.equal(keptUntil(undefined), "")
		assert.equal(keptUntil("soon](https://evil.test)"), "")
	})
})

describe("parseTmAddReport keeps the folder page", () => {
	test("folderUrl is passed through", () => {
		const out = JSON.stringify({ project: "PR-164148", folderId: "61742797", folderUrl: FOLDER, created: [], failed: [], skipped: [] })
		assert.equal(parseTmAddReport(out).folderUrl, FOLDER)
	})
	test("an older CLI without it gives an empty one", () => {
		assert.equal(parseTmAddReport(JSON.stringify({ created: [] })).folderUrl, "")
	})
})

describe("a saved generate links its folder", () => {
	const report = { created: [{ identifier: "TC-1", title: "One" }], failed: [], skipped: [], folderUrl: FOLDER, folderId: "61742797" }

	test("the answer names the folder as a link", () => {
		assert.ok(renderExactSave(report, where).includes(`to [github-app in rag\\_assignment](${FOLDER}) exactly as planned`))
	})
	test("without a reported page it stays plain text", () => {
		const text = renderExactSave({ ...report, folderUrl: "" }, where)
		assert.match(text, /to github-app in rag\\_assignment exactly as planned/)
		assert.doesNotMatch(text, /\]\(https:/)
	})
	test("a page for a different folder is not linked", () => {
		assert.doesNotMatch(renderExactSave({ ...report, folderId: "1" }, where), /\]\(https:/)
	})
	test("the counts line links the folder too", () => {
		const body = renderJobSummary({
			outcome: "Succeeded",
			summary: { cases_generated: "1", cases_saved: "1", saved_to: "github-app in rag_assignment" },
			savedToUrl: FOLDER,
		})
		assert.ok(body.includes(`They are in [github-app in rag\\_assignment](${FOLDER}).`))
		assert.doesNotMatch(body, /Download/)
	})
	test("a link in the agent-writable summary is never used", () => {
		const body = renderJobSummary({
			outcome: "Succeeded",
			summary: { cases_generated: "1", cases_saved: "1", saved_to: "x", saved_to_url: "https://evil.test" },
		})
		assert.doesNotMatch(body, /evil/)
		assert.ok(body.includes("They are in x."))
	})
	test("a folder name can't break out into Markdown, a mention or a link", () => {
		const name = "F\n\n# Heading @octocat https://evil.test ](https://evil.test)"
		for (const savedToUrl of [FOLDER, undefined]) {
			const body = renderJobSummary({
				outcome: "Succeeded",
				summary: { cases_generated: "1", cases_saved: "1", saved_to: name },
				savedToUrl,
			})
			const line = body.split("\n").find((l) => l.startsWith("**Test cases:**"))
			assert.ok(line.includes(plain(name)), line)
			assert.doesNotMatch(body, /^# Heading/m)
			assert.doesNotMatch(body, /@octocat/)
			assert.doesNotMatch(body, /https:\/\/evil/)
		}
	})
	test("an interrupted save has no report, so names the folder without a link", () => {
		assert.match(renderSaveInterrupted(where, "killed"), /Check github-app in rag\\_assignment before/)
	})
})

describe("cases that weren't saved get one download link, with how long it lasts", () => {
	test("none saved: the direct link replaces 'download the result below'", () => {
		const body = renderJobSummary({
			outcome: "Run broke",
			summary: { cases_generated: "3", cases_saved: "0" },
			casesDownloadUrl: DOWNLOAD,
			casesKeptUntil: "until 2026-11-30",
			resultArtifact: "test-companion-result",
			runUrl: RUN,
		})
		assert.ok(body.includes(`**Nothing was written to Test Management.** [Download the test cases](${DOWNLOAD}), kept until 2026-11-30, to keep them.`))
		assert.doesNotMatch(body, /artifact on this run/)
	})
	test("no direct link: point at the run page's Artifacts", () => {
		const body = renderJobSummary({ outcome: "Succeeded", summary: { cases_generated: "3", cases_saved: "1" }, runUrl: RUN })
		assert.ok(body.includes(`Some of them were not saved. Download them from the **Artifacts** section of the [run page](${RUN}) to keep them.`))
	})
	test("all saved: no download advice", () => {
		const body = renderJobSummary({
			outcome: "Succeeded",
			summary: { cases_generated: "3", cases_saved: "3" },
			resultArtifact: "test-companion-result",
			runUrl: RUN,
		})
		assert.doesNotMatch(body, /Download|artifact on this run/)
	})
	test("a save that couldn't start links the approved cases and says until when", () => {
		const text = renderCasesUnavailable("save-failed", "project not found", { download: DOWNLOAD, until: "until 2026-11-30" })
		assert.ok(text.includes(`You can still [download the approved test cases](${DOWNLOAD}), kept until 2026-11-30.`))
	})
	test("without a link the reply is as before", () => {
		assert.doesNotMatch(renderCasesUnavailable("changed"), /download/)
	})
	test("some failed: the answer lists them, and the link is given once, below", () => {
		const report = { created: [{ identifier: "TC-1", title: "One" }], failed: [{ title: "Two", error: "bad field" }], skipped: [] }
		const answer = renderExactSave(report, where)
		assert.doesNotMatch(answer, /Download/)
		const body = renderJobSummary({
			outcome: "Run broke",
			answer,
			summary: { cases_generated: "2", cases_saved: "1" },
			casesDownloadUrl: DOWNLOAD,
		})
		assert.equal(body.split(DOWNLOAD).length - 1, 1)
	})
})

describe("a plan says nothing is saved yet, and sets the next step apart", () => {
	test("a plan's counts don't offer a download", () => {
		const body = renderJobSummary({
			outcome: "Succeeded",
			proposing: true,
			summary: { cases_generated: "10", cases_saved: "0", preview: "true" },
			resultArtifact: "test-companion-result",
			runUrl: RUN,
		})
		assert.ok(body.includes("**Test cases:** 10 generated. Nothing is saved until you approve."))
		assert.doesNotMatch(body, /Download|Nothing was written|artifact on this run/)
	})
	test("a plan whose run did save some says so, rather than 'nothing is saved'", () => {
		const body = renderJobSummary({ outcome: "Succeeded", proposing: true, summary: { cases_generated: "10", cases_saved: "8" } })
		assert.ok(body.includes("**8 were already saved to Test Management while making this plan**, so approving it may save them again."))
		assert.doesNotMatch(body, /Nothing is saved until you approve/)
	})
	test("the next step is a highlighted box naming what go does", () => {
		const box = renderNextStep("generate")
		assert.match(box, /^> \[!IMPORTANT\]\n/)
		assert.match(box, /reply `go` to save these test cases to Test Management/)
		assert.match(box, /reply `@browserstack go` followed by your changes/)
		assert.match(box, /stops being approvable after a day/)
		assert.ok(box.split("\n").every((l) => l.startsWith(">")))
	})
	test("each job says what go does; an unknown one says run", () => {
		assert.match(renderNextStep("fix"), /apply this fix as a pull request/)
		assert.match(renderNextStep("test-pr"), /write these tests to this branch/)
		assert.match(renderNextStep("test"), /write these tests to this branch/)
		assert.match(renderNextStep("anything"), /run this for real/)
	})
	test("the proposal ends with the box, then its marker", () => {
		const body = renderProposal("the plan", "a".repeat(40), "octocat", "generate", "1")
		const box = body.indexOf("> [!IMPORTANT]")
		assert.ok(box > body.indexOf("the plan"))
		assert.ok(body.indexOf("<!-- test-companion-proposal") > box)
	})
})

describe("the Plan row links the plan", () => {
	test("View plan, linking the approved plan's comment", () => {
		const url = "https://github.com/o/r/pull/1#issuecomment-5"
		const body = renderJobSummary({ outcome: "Succeeded", approvedPlan: { id: 5, url } })
		assert.ok(body.includes(`| Plan | [View plan](${url}) |`))
	})
})

describe("the wiring in main.mjs", () => {
	const main = readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8")
	const planBlock = main.slice(main.indexOf("if (proposing && !runDidNotWork(outcome))"), main.indexOf('setOutput("outcome", "Proposed")'))

	test("a plan's comment, job summary and check are all rendered as a plan", () => {
		assert.match(planBlock, /const planView = \{ \.\.\.view, proposing: true \}/)
		assert.match(planBlock, /addToJobSummary\(renderJobSummary\(planView\)\)/)
		assert.match(planBlock, /renderSummaryWithin\(planView,/)
		assert.match(planBlock, /postCheck\(outcome, planView,/)
		assert.doesNotMatch(planBlock, /renderJobSummary\(view\)|postCheck\(outcome, view,/)
	})
	test("the folder link comes only from the save's own report, checked against its folder", () => {
		assert.match(main, /savedToUrl: tmFolderUrl\(report\.folderUrl, report\.folderId\)/)
		assert.equal(main.match(/savedToUrl:/g).length, 1)
		assert.doesNotMatch(main, /summary\.saved_to_url|summary\.folder_url/)
	})
	test("an unexpected failure after the file is confirmed still links it", () => {
		assert.match(main, /unavailable\("save-failed", redactSecrets\(String\(e\?\.message \?\? e\), secretsNow\(\)\), kept\)/)
	})
})
