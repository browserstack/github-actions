import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { renderJobSummary, renderNextStep, renderProposal } from "../src/report.mjs"
import {
	tmFolderLink,
	artifactDownloadLink,
	readCasesDestination,
	renderCasesUnavailable,
	renderExactSave,
	renderSaveInterrupted,
} from "../src/approved-cases.mjs"

const FOLDER = "https://test-management.browserstack.com/projects/PR-164148/folder/61742797"
const DOWNLOAD = "https://github.com/o/r/actions/runs/123/artifacts/456"
const RUN = "https://github.com/o/r/actions/runs/999"
const where = { project: "rag_assignment", folder: "github-app", projectId: "PR-164148", folderId: "61742797" }

describe("tmFolderLink: the folder's Test Management page, from ids only", () => {
	test("a project code and a numeric folder id make the link", () => {
		assert.equal(tmFolderLink("PR-164148", "61742797"), FOLDER)
	})
	test("anything else gives no link", () => {
		assert.equal(tmFolderLink("", "1"), undefined)
		assert.equal(tmFolderLink("PR-1", ""), undefined)
		assert.equal(tmFolderLink("PR-1/../../x", "1"), undefined)
		assert.equal(tmFolderLink("PR-1", "1?next=https://evil.test"), undefined)
		assert.equal(tmFolderLink("PR 1", "1"), undefined)
	})
})

describe("artifactDownloadLink: GitHub's page for one artifact", () => {
	test("repo, run and artifact ids make the link", () => {
		assert.equal(artifactDownloadLink("o/r", "123", 456), DOWNLOAD)
	})
	test("anything else gives no link", () => {
		assert.equal(artifactDownloadLink("o/r", "123", undefined), undefined)
		assert.equal(artifactDownloadLink("o", "123", "456"), undefined)
		assert.equal(artifactDownloadLink("o/r/x", "123", "456"), undefined)
		assert.equal(artifactDownloadLink("o/r", "12a", "456"), undefined)
	})
})

describe("readCasesDestination keeps the ids the link needs", () => {
	test("ids are passed through when present", () => {
		const text = JSON.stringify({ destination: where, cases: [] })
		assert.deepEqual(readCasesDestination(text), where)
	})
})

describe("a saved generate links its folder", () => {
	const report = { created: [{ identifier: "TC-1", title: "One" }], failed: [], skipped: [] }

	test("the answer names the folder as a link", () => {
		assert.match(renderExactSave(report, where), /to \[github-app in rag\\_assignment\]\(https:\/\/test-management\.browserstack\.com\/projects\/PR-164148\/folder\/61742797\) exactly as planned/)
	})
	test("without ids it stays plain text", () => {
		const text = renderExactSave(report, { project: "rag_assignment", folder: "github-app" })
		assert.match(text, /to github-app in rag\\_assignment exactly as planned/)
		assert.doesNotMatch(text, /\]\(https:/)
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
		assert.ok(body.includes("They are in `x`."))
	})
	test("an interrupted save links the folder to check", () => {
		assert.match(renderSaveInterrupted(where, "killed"), /Check \[github-app in rag\\_assignment\]\(https:/)
	})
})

describe("cases that weren't saved get a download link", () => {
	test("none saved: the direct link replaces 'download the result below'", () => {
		const body = renderJobSummary({
			outcome: "Run broke",
			summary: { cases_generated: "3", cases_saved: "0" },
			casesDownloadUrl: DOWNLOAD,
			resultArtifact: "test-companion-result",
			runUrl: RUN,
		})
		assert.ok(body.includes(`**Nothing was written to Test Management.** [Download the test cases](${DOWNLOAD}) to keep them.`))
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
	test("a save that couldn't start links the approved cases", () => {
		const text = renderCasesUnavailable("save-failed", "project not found", { download: DOWNLOAD })
		assert.ok(text.includes(`The approved test cases aren't lost: [download them](${DOWNLOAD}).`))
	})
	test("without a link the reply is as before", () => {
		assert.doesNotMatch(renderCasesUnavailable("changed"), /download them/)
	})
	test("some failed: the answer links the approved cases", () => {
		const report = { created: [{ identifier: "TC-1", title: "One" }], failed: [{ title: "Two", error: "bad field" }], skipped: [] }
		assert.ok(renderExactSave(report, where, { download: DOWNLOAD }).includes(`[Download the approved test cases](${DOWNLOAD})`))
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
	test("the next step is a highlighted box naming what go does", () => {
		const box = renderNextStep("generate")
		assert.match(box, /^> \[!IMPORTANT\]\n/)
		assert.match(box, /reply `go` to save these test cases to Test Management/)
		assert.match(box, /reply `@browserstack go` followed by your changes/)
		assert.match(box, /stops being approvable after a day/)
		assert.ok(box.split("\n").every((l) => l.startsWith(">")))
	})
	test("each job says what go does; an unknown one says run", () => {
		assert.match(renderNextStep("fix"), /apply this fix as a draft pull request/)
		assert.match(renderNextStep("test-pr"), /write these tests to this branch/)
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
