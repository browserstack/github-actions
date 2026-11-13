/**
 * Saving the exact test cases a reviewer approved.
 *
 * A `generate` plan is a preview: it lists the cases it would create and saves nothing.
 * Its run keeps those cases as data (the CLI's `<result-file>.json`) in an artifact. A plain
 * `go` then saves that file with `tc tm add --from-file`, which runs no AI: what the reviewer
 * read is what reaches Test Management. Before this, `go` generated the cases again and saved
 * a different set.
 *
 * Everything here is pure; main.mjs does the API calls and runs tc.
 */
import { hasApproverEdits } from "./report.mjs"

/** The artifact a generate preview leaves: the cases file plus subject.json naming its repo and commit. */
export const CASES_ARTIFACT = "test-companion-cases"
export const CASES_DATA_FILE = "result.md.json"
export const CASES_SUBJECT_FILE = "subject.json"

/**
 * How a `go` on a plan is carried out:
 *   - "exact": save the plan's own cases with tm add, no new run;
 *   - "unavailable": should be exact, but there is nothing to fetch (say so, never regenerate);
 *   - "run": a real run of the job. For generate that only happens when the approver changed the
 *     plan (`edited`), which tm add cannot apply.
 * Where the cases go is read from the plan's own cases file, not from here.
 *
 * Safety rule: a plain go on a generate plan never becomes "run". Generating again would save
 * cases nobody reviewed, so every problem after this point is reported instead.
 */
export function approvedSavePlan({ workflow, replyText, runId } = {}) {
	if (workflow !== "generate") return { mode: "run" }
	if (hasApproverEdits(replyText)) return { mode: "run", edited: true }
	// Plans made before the run id was recorded have nothing to fetch.
	if (!/^\d+$/.test(String(runId ?? ""))) return { mode: "unavailable", reason: "no-run" }
	return { mode: "exact", runId: String(runId) }
}

/**
 * Where the approved cases go, from the cases file the plan's run kept (its top-level
 * `destination`). The CLI writes it only when a Test Management destination is configured.
 */
export function readCasesDestination(casesText) {
	let data
	try {
		data = JSON.parse(String(casesText ?? ""))
	} catch {
		return { error: "unreadable" }
	}
	if (!data || typeof data !== "object" || !Array.isArray(data.cases)) return { error: "unreadable" }
	const project = String(data.destination?.project ?? "").trim()
	const folder = String(data.destination?.folder ?? "").trim()
	if (!project || !folder) return { error: "no-destination" }
	return { project, folder }
}

/** The plan run's cases artifact from a `GET .../runs/<id>/artifacts` reply, or why there is none. */
export function pickCasesArtifact(list, runId) {
	const want = String(runId ?? "")
	const mine = (list?.artifacts ?? []).filter((a) => a?.name === CASES_ARTIFACT && String(a?.workflow_run?.id ?? "") === want)
	if (mine.length === 0) return { error: "missing" }
	const live = mine.find((a) => !a.expired)
	return live ? { artifact: live } : { error: "expired" }
}

/** What the plan run records about itself, so a go run can't save cases made for another repo or commit. */
export function casesSubject({ repo, sha }) {
	return { repo: String(repo ?? ""), sha: String(sha ?? "") }
}

/** Whether a downloaded subject.json matches the repo and commit being approved; `why` when not. */
export function checkCasesSubject(subjectText, { repo, sha }) {
	let subject
	try {
		subject = JSON.parse(String(subjectText ?? ""))
	} catch {
		return { ok: false, why: "unreadable" }
	}
	if (!subject || subject.repo !== repo) return { ok: false, why: "other-repo" }
	if (!sha || subject.sha !== sha) return { ok: false, why: "other-commit" }
	return { ok: true }
}

/**
 * `tc tm add --json` output: { project, folderId, created[], failed[], skipped[] }.
 * Undefined when it printed no report, which means it stopped before saving anything.
 */
export function parseTmAddReport(stdout) {
	const text = String(stdout ?? "").trim()
	if (!text) return undefined
	// The report is the last JSON object printed.
	const start = text.lastIndexOf("\n{")
	const candidate = start >= 0 ? text.slice(start + 1) : text
	let report
	try {
		report = JSON.parse(candidate)
	} catch {
		try {
			report = JSON.parse(text)
		} catch {
			return undefined
		}
	}
	if (!report || typeof report !== "object" || !Array.isArray(report.created)) return undefined
	return {
		project: String(report.project ?? ""),
		folderId: String(report.folderId ?? ""),
		created: report.created,
		failed: Array.isArray(report.failed) ? report.failed : [],
		skipped: Array.isArray(report.skipped) ? report.skipped : [],
	}
}

const UNAVAILABLE_WHY = {
	"no-run": "this plan was made before plans kept their cases, so there is no saved list to use",
	missing: "the plan's run did not keep its cases",
	expired: "the plan's saved cases have expired",
	"download-failed": "I could not download the plan's saved cases",
	unreadable: "the plan's saved cases could not be read",
	"other-repo": "the saved cases are not from this repository",
	"other-commit": "the saved cases are for a different commit than this plan",
	"no-destination": "the plan recorded no Test Management destination, so there is nowhere to save its cases",
	"save-failed": "Test Management refused the cases before any were saved",
}

/** The reply when the approved cases can't be saved as they are. Never regenerates. */
export function renderCasesUnavailable(reason, detail) {
	const why = UNAVAILABLE_WHY[reason] ?? "the plan's cases could not be used"
	const extra = String(detail ?? "").trim()
	return [
		`I did not save anything: ${why}${extra ? ` (${extra})` : ""}.`,
		"",
		reason === "no-destination"
			? "I have not generated a new set in its place, because that would save cases nobody reviewed. Set `tm_project` and `tm_folder` for generate in the pipeline file, then ask me to **generate** again and approve the fresh plan."
			: "I have not generated a new set in its place, because that would save cases nobody reviewed. Ask me to **generate** again and approve the fresh plan.",
	].join("\n")
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim()

/** The answer text for an exact save: what was created, with ids, and anything that failed. */
export function renderExactSave(report, { project, folder } = {}) {
	const created = report?.created ?? []
	const failed = report?.failed ?? []
	const skipped = report?.skipped ?? []
	const lines = []
	const where = `${folder} in ${project}`
	if (created.length > 0) {
		lines.push(`Saved the ${created.length} approved test case${created.length === 1 ? "" : "s"} to \`${where}\` exactly as planned; nothing was generated again.`)
		lines.push("")
		for (const c of created) {
			const id = oneLine(c.identifier)
			const label = c.url && id ? `[${id}](${c.url})` : id
			lines.push(`- ${label}${label ? " — " : ""}${oneLine(c.title)}`)
		}
	}
	if (failed.length > 0) {
		if (lines.length) lines.push("")
		lines.push(`**${failed.length} could not be saved:**`)
		lines.push("")
		for (const f of failed) lines.push(`- ${oneLine(f.title)}: ${oneLine(f.error)}`)
	}
	if (skipped.length > 0) {
		if (lines.length) lines.push("")
		lines.push(`${skipped.length} were already saved earlier and were left alone.`)
	}
	if (lines.length === 0) lines.push("The plan had no test cases to save.")
	return lines.join("\n")
}

/** The counts the report table shows, taken from what tm add actually did. */
export function exactSaveSummary(report, { project, folder } = {}) {
	const created = report?.created?.length ?? 0
	const failed = report?.failed?.length ?? 0
	const skipped = report?.skipped?.length ?? 0
	return {
		workflow: "generate",
		event: "pr_comment",
		cases_generated: String(created + failed + skipped),
		cases_saved: String(created + skipped),
		saved_to: `${folder} in ${project}`,
	}
}

/**
 * How an exact save ends. `spend` is whether the plan is used up: once any case is saved,
 * approving the same plan again would save those cases twice, so it is spent even when some
 * failed. When none were saved it stays approvable.
 */
export function exactSaveOutcome(report, outcomes) {
	const created = report?.created?.length ?? 0
	const failed = report?.failed?.length ?? 0
	const skipped = report?.skipped?.length ?? 0
	if (failed === 0) return { outcome: outcomes.SUCCEEDED, spend: true }
	return { outcome: outcomes.RUN_BROKE, spend: created + skipped > 0 }
}

/** A note for the reply when a go with edits had to generate again. */
export const EDITED_GO_NOTE =
	"Your go included changes, and saving the plan as it was can't apply them, so the cases were generated again with your changes as guidance. Check the list below; it may differ from the plan."
