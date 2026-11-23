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
import { createHash } from "node:crypto"
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
export function approvedSavePlan({ workflow, replyText, runId, casesSha256, casesShown } = {}) {
	if (workflow !== "generate") return { mode: "run" }
	if (hasApproverEdits(replyText)) return { mode: "run", edited: true }
	// A plan that didn't show all its cases, or showed the agent's text instead, wasn't reviewed in full.
	if (casesShown === "partial") return { mode: "unavailable", reason: "partial" }
	if (casesShown === "markdown") return { mode: "unavailable", reason: "unchecked" }
	// Plans made before the run id was recorded have nothing to fetch.
	if (!/^\d+$/.test(String(runId ?? ""))) return { mode: "unavailable", reason: "no-run" }
	// Without the fingerprint of the cases the plan showed, nothing ties the saved file to them.
	if (!/^[0-9a-f]{64}$/.test(String(casesSha256 ?? ""))) return { mode: "unavailable", reason: "no-digest" }
	return { mode: "exact", runId: String(runId), casesSha256: String(casesSha256) }
}

/** The sha256 of a cases file, as recorded in the plan and checked before saving. */
export function casesDigest(bytes) {
	return createHash("sha256").update(bytes ?? "").digest("hex")
}

// Agent-written text shown in the plan: one line, no Markdown, no @mentions or autolinks.
const plain = (s) =>
	String(s ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\\`*_{}[\]()<>#+!|~]/g, "\\$&")
		.replace(/@/g, "@\u200b")
		.replace(/:\/\//g, ":\u200b//")

// Agent-written text that may span lines, shown in a code block: nothing in it is Markdown,
// a mention or a link. The fence is longer than any run of backticks inside.
const block = (s) => {
	const text = String(s ?? "").replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "")
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length))
	const fence = "`".repeat(longest + 1)
	return `${fence}text\n${text}\n${fence}`
}
// Text inside <summary>, which is HTML, not Markdown.
const summaryText = (s) =>
	String(s ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/@/g, "@\u200b")
		.replace(/:\/\//g, ":\u200b//")

const isText = (v) => typeof v === "string"
const isTextList = (v) => Array.isArray(v) && v.every(isText)
const isTextMap = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(isText)
const isStepList = (v) =>
	Array.isArray(v) &&
	v.every((st) => st && typeof st === "object" && !Array.isArray(st) && Object.entries(st).every(([k, x]) => STEP_FIELDS.has(k) && (x === undefined || x === null || isText(x))))
const textLine = (label) => (v) => `**${label}:** ${plain(v)}`
const textBlock = (label) => (v) => (/\n/.test(v) ? `**${label}:**\n\n${block(v)}\n` : `**${label}:** ${plain(v)}`)

// A step's fields; any other key in a step is not shown, so a case carrying one is refused.
const STEP_FIELDS = new Set(["step", "result"])

/**
 * Every field of a case in the cases file that the plan shows, in the order shown: the one list
 * both the plan and the pre-save check use, so they can't drift. `id`, `title` and `folder` are
 * shown in the case's heading; `render` is undefined for those. These are all the fields
 * `tc tm add --from-file` sends (a BDD case's feature, scenario and background included).
 */
const CASE_FIELDS = {
	id: { valid: isText },
	title: { valid: isText },
	folder: { valid: isText },
	format: { valid: isText, render: (v) => `**Format:** ${String(v).toLowerCase() === "bdd" ? "BDD" : plain(v)}` },
	type: { valid: isText, render: textLine("Type") },
	priority: { valid: isText, render: textLine("Priority") },
	tags: { valid: isTextList, render: (v) => `**Tags:** ${v.map(plain).join(", ")}` },
	description: { valid: isText, render: textBlock("Description") },
	preconditions: { valid: isText, render: textBlock("Before you start") },
	feature: { valid: isText, render: textBlock("Feature") },
	background: { valid: isText, render: textBlock("Background") },
	bddScenario: { valid: isText, render: textBlock("Scenario") },
	steps: {
		valid: isStepList,
		render: (v) =>
			[
				"**Steps:**",
				"",
				...v.flatMap((st, n) => [
					`${n + 1}. ${plain(st?.step)}`,
					...(String(st?.result ?? "").trim() ? [`   - Expected: ${plain(st.result)}`] : []),
				]),
			].join("\n"),
	},
	references: { valid: isTextList, render: (v) => ["**References:**", "", ...v.map((r) => `- ${plain(r)}`)].join("\n") },
	customFields: {
		valid: isTextMap,
		render: (v) => ["**Custom fields:**", "", ...Object.entries(v).map(([k, x]) => `- ${plain(k)}: ${plain(x)}`)].join("\n"),
	},
}

/** The case fields the plan shows. */
export const RENDERED_CASE_FIELDS = Object.freeze(Object.keys(CASE_FIELDS))

const isEmpty = (v) =>
	v === undefined ||
	v === null ||
	(typeof v === "string" && v.trim() === "") ||
	(Array.isArray(v) && v.length === 0) ||
	(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)

/**
 * The fields the plan can't show, as "T003: links" labels: a non-empty field not in
 * RENDERED_CASE_FIELDS (an unknown or newer one), or one whose value isn't the shape the plan
 * shows. Any of these means approving can't save the cases exactly as shown.
 */
export function unshownFields(data) {
	const out = []
	const cases = Array.isArray(data?.cases) ? data.cases : []
	cases.forEach((c, i) => {
		const name = isText(c?.id) && c.id.trim() ? c.id.trim() : `#${i + 1}`
		if (!c || typeof c !== "object" || Array.isArray(c)) {
			out.push(`${name}: not a test case`)
			return
		}
		for (const [key, value] of Object.entries(c)) {
			if (isEmpty(value)) continue
			const field = CASE_FIELDS[key]
			if (!field || !field.valid(value)) out.push(`${name}: ${key}`)
		}
	})
	return out
}

/** One case, every field the cases file holds for it, in a collapsible block. */
function renderCase(c, i) {
	const id = isText(c.id) && c.id.trim() ? c.id : `#${i + 1}`
	const heading = `${summaryText(id)} — ${summaryText(c.title) || "(untitled)"}`
	const lines = []
	if (isText(c.folder) && c.folder.trim()) {
		lines.push(`_Already in Test Management (${plain(c.folder)}): saving skips this case._`, "")
	}
	for (const [key, field] of Object.entries(CASE_FIELDS)) {
		const value = c[key]
		if (!field.render || isEmpty(value) || !field.valid(value)) continue
		lines.push(field.render(value), "")
	}
	return [`<details><summary>${heading}</summary>`, "", ...lines, "</details>"].join("\n")
}

/**
 * The plan the reviewer reads, from the same cases file that approving saves, so what is
 * shown and what is saved can't differ. Every field `tc tm add` sends is shown; fields it
 * can't show are listed, and approving such a plan is refused before saving.
 *
 * `maxChars` is the room left in the comment. A plan that doesn't fit shows the cases that
 * do, says so, and returns `complete: false`: it can't be approved for an exact save.
 *
 * Returns { body, digest, complete, unshown } or undefined when the file can't be read as cases.
 */
export function renderPlannedCases(bytes, { maxChars = 55_000 } = {}) {
	let data
	try {
		data = JSON.parse(Buffer.from(bytes ?? "").toString("utf8"))
	} catch {
		return undefined
	}
	if (!data || typeof data !== "object" || !Array.isArray(data.cases)) return undefined
	const cases = data.cases
	const where = readCasesDestination(JSON.stringify(data))
	const head = where.error
		? "**Will be saved to:** nowhere. This plan records no Test Management destination, so approving it can't save these cases."
		: `**Will be saved to:** ${whereLinked(where)}, once approved.`
	const count = `**${cases.length} test case${cases.length === 1 ? "" : "s"}:**`
	const unshown = unshownFields(data)
	const warning = unshown.length
		? `**Approving this plan can't save its cases exactly as shown:** some cases carry fields this plan can't show (${unshown
				.slice(0, 20)
				.map(plain)
				.join(", ")}${unshown.length > 20 ? ", …" : ""}). Ask me to **generate** again.`
		: ""
	const top = [head, ...(warning ? ["", warning] : []), "", count, ""].join("\n")
	const tooLarge = (shown) =>
		`**This plan is too large to show in full** (${shown} of ${cases.length} cases shown), so it can't be approved to save exactly as shown. Ask me to **generate** fewer cases.`
	const rendered = cases.map((c, i) => (c && typeof c === "object" && !Array.isArray(c) ? renderCase(c, i) : `- #${i + 1}: not a test case`))
	const all = rendered.join("\n\n")
	if (top.length + all.length <= maxChars) {
		return { body: top + all, digest: casesDigest(bytes), complete: true, unshown }
	}
	// Room for the note, then as many whole cases as fit.
	const room = maxChars - top.length - tooLarge(cases.length).length - 4
	const kept = []
	let used = 0
	for (const r of rendered) {
		if (used + r.length + 2 > room) break
		kept.push(r)
		used += r.length + 2
	}
	return {
		body: [top + tooLarge(kept.length), "", kept.join("\n\n")].join("\n"),
		digest: casesDigest(bytes),
		complete: false,
		unshown,
	}
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
	const projectId = String(data.destination?.projectId ?? "").trim()
	const folderId = String(data.destination?.folderId ?? "").trim()
	return { project, folder, ...(projectId ? { projectId } : {}), ...(folderId ? { folderId } : {}) }
}

/**
 * The Test Management page of a folder, or undefined. Built only from ids of the expected shape,
 * so nothing in the cases file can turn it into a link elsewhere.
 */
export function tmFolderLink(projectId, folderId) {
	const project = String(projectId ?? "")
	const folder = String(folderId ?? "")
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(project) || !/^\d{1,20}$/.test(folder)) return undefined
	return `https://test-management.browserstack.com/projects/${project}/folder/${folder}`
}

/** GitHub's download page for one artifact of a run in this repository, or undefined. */
export function artifactDownloadLink(repo, runId, artifactId) {
	const r = String(repo ?? "")
	const run = String(runId ?? "")
	const artifact = String(artifactId ?? "")
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) || !/^\d+$/.test(run) || !/^\d+$/.test(artifact)) return undefined
	return `https://github.com/${r}/actions/runs/${run}/artifacts/${artifact}`
}

// "folder in project", linked to the folder when its ids are known.
function whereLinked({ project, folder, projectId, folderId } = {}) {
	const where = `${plain(folder)} in ${plain(project)}`
	const url = tmFolderLink(projectId, folderId)
	return url ? `[${where}](${url})` : where
}

/**
 * The plan run's cases artifact from a `GET .../runs/<id>/artifacts` reply, or why there is none.
 * The run must belong to this repository and have started from it (`repoId`, GitHub's numeric
 * id): fails closed when either is missing. Its commit is not compared: a plan asked for in a
 * comment runs on the default branch's commit, and the plan's own commit is checked through
 * subject.json and the cases' fingerprint instead.
 */
export function pickCasesArtifact(list, runId, { repoId } = {}) {
	const want = String(runId ?? "")
	const named = (list?.artifacts ?? []).filter((a) => a?.name === CASES_ARTIFACT && String(a?.workflow_run?.id ?? "") === want)
	if (named.length === 0) return { error: "missing" }
	const repo = String(repoId ?? "")
	const ours = (a) =>
		repo !== "" && String(a?.workflow_run?.repository_id ?? "") === repo && String(a?.workflow_run?.head_repository_id ?? "") === repo
	const mine = named.filter(ours)
	if (mine.length === 0) return { error: "other-repo" }
	const live = mine.find((a) => !a.expired)
	return live ? { artifact: live } : { error: "expired" }
}

/**
 * What the plan run records about itself, so a go run can't save cases made for another repo or
 * commit. `cli` is the `tc --version` line that made the plan, to tell an older CLI apart from a
 * missing destination.
 */
export function casesSubject({ repo, sha, cli }) {
	return { repo: String(repo ?? ""), sha: String(sha ?? ""), cli: String(cli ?? "") }
}

// The first CLI whose cases file records its Test Management destination.
export const CASES_DESTINATION_CLI = "1.1.16"

/** The x.y.z in a `tc --version` line, as numbers, or undefined. */
export function cliVersionOf(text) {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""))
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

/** Whether that CLI writes a destination into its cases file: true, false, or undefined when unknown. */
export function cliRecordsDestination(text) {
	const v = cliVersionOf(text)
	if (!v) return undefined
	const min = cliVersionOf(CASES_DESTINATION_CLI)
	for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i]
	return true
}

/**
 * Why a cases file with no destination can't be saved: "old-cli-plan" when the plan's CLI is
 * known to predate destinations, else "no-destination" (none configured, or the CLI unknown).
 */
export function missingDestinationReason(planCli) {
	return cliRecordsDestination(planCli) === false ? "old-cli-plan" : "no-destination"
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
	return { ok: true, cli: String(subject.cli ?? "") }
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
	"no-digest": "this plan didn't record which cases it showed (an older version of Test Companion made it)",
	changed: "the saved cases are not the ones this plan showed",
	partial: "this plan was too large to show every case, so not all of it was reviewed",
	unchecked: "this plan couldn't be shown from its cases file, so what it showed can't be checked against what would be saved",
	unshown: "some cases carry fields the plan couldn't show, so they weren't reviewed",
	"no-destination": "the plan recorded no Test Management destination, so there is nowhere to save its cases",
	"old-cli": `saving a plan's own cases needs Test Companion CLI ${CASES_DESTINATION_CLI} or later, and this run has an older one`,
	"old-cli-plan": `this plan was made with a Test Companion CLI older than ${CASES_DESTINATION_CLI}, which doesn't record where to save its cases`,
	"save-failed": "the save stopped before any case was saved",
	"lookup-failed": "I couldn't look up the plan's saved cases on GitHub just now",
}

/**
 * The reply when the approved cases can't be saved as they are. Never regenerates. `download` is
 * the plan's cases artifact, given only when those cases are the approved ones.
 */
export function renderCasesUnavailable(reason, detail, { download } = {}) {
	const why = UNAVAILABLE_WHY[reason] ?? "the plan's cases could not be used"
	const extra = String(detail ?? "").trim()
	const notInstead = "I have not generated a new set in its place, because that would save cases nobody reviewed."
	const update = `Update the CLI: remove the action's \`cli-version\` pin, or pin ${CASES_DESTINATION_CLI} or later.`
	const next = {
		"lookup-failed": `${notInstead} Reply **go** to this plan again in a minute; it is still waiting.`,
		partial: `${notInstead} Ask me to **generate** fewer cases, then approve the fresh plan.`,
		"no-destination": `${notInstead} Set \`tm_project\` and \`tm_folder\` for generate in the pipeline file. If they are already set, the plan was probably made with a CLI older than ${CASES_DESTINATION_CLI}: ${update} Then ask me to **generate** again and approve the fresh plan.`,
		"old-cli": `${notInstead} ${update} Then reply **go** to this plan again; it is still waiting.`,
		"old-cli-plan": `${notInstead} ${update} Then ask me to **generate** again and approve the fresh plan.`,
	}
	const keep = download ? ["", `The approved test cases aren't lost: [download them](${download}).`] : []
	return [
		`I did not save anything: ${why}${extra ? ` (${extra})` : ""}.`,
		"",
		next[reason] ?? `${notInstead} Ask me to **generate** again and approve the fresh plan.`,
		...keep,
	].join("\n")
}

/** A link to a saved case, only to BrowserStack over https; anything else is not linked. */
export function browserstackLink(url) {
	let u
	try {
		u = new URL(String(url ?? ""))
	} catch {
		return undefined
	}
	const host = u.hostname.toLowerCase()
	if (u.protocol !== "https:" || u.username || u.password) return undefined
	if (host !== "browserstack.com" && !host.endsWith(".browserstack.com")) return undefined
	// href percent-encodes spaces and angle brackets, so it is safe inside <...>.
	return u.href
}

/** The answer text for an exact save: what was created, with ids, and anything that failed. */
export function renderExactSave(report, destination = {}, { download } = {}) {
	const created = report?.created ?? []
	const failed = report?.failed ?? []
	const skipped = report?.skipped ?? []
	const lines = []
	const where = whereLinked(destination)
	if (created.length > 0) {
		lines.push(`Saved the ${created.length} approved test case${created.length === 1 ? "" : "s"} to ${where} exactly as planned; nothing was generated again.`)
		lines.push("")
		for (const c of created) {
			const id = plain(c.identifier)
			const link = browserstackLink(c.url)
			const label = link && id ? `[${id}](<${link}>)` : id
			lines.push(`- ${label}${label ? " — " : ""}${plain(c.title)}`)
		}
	}
	if (failed.length > 0) {
		if (lines.length) lines.push("")
		lines.push(`**${failed.length} could not be saved:**`)
		lines.push("")
		for (const f of failed) lines.push(`- ${plain(f.title)}: ${plain(f.error)}`)
		if (download) lines.push("", `[Download the approved test cases](${download}) to keep the ones that weren't saved.`)
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

/**
 * The reply when `tc tm add` stopped without saying what it saved (killed, timed out, or no
 * report). Some cases may be in Test Management, so the plan is used up: approving it again
 * could save them twice.
 */
export function renderSaveInterrupted(destination = {}, why) {
	const where = destination.project && destination.folder ? whereLinked(destination) : "Test Management"
	const extra = String(why ?? "").trim()
	return [
		`The save stopped before it reported what it saved${extra ? ` (${plain(extra)})` : ""}, so some of the approved cases may already be in ${where}.`,
		"",
		`This plan is now used up, so approving it again can't save them twice. Check ${where} before asking me to **generate** again.`,
	].join("\n")
}

/**
 * Whether `tc tm add` said, in its own words, that it saved nothing.
 */
export function tmAddSavedNothing(stderr) {
	return /\bnothing was saved\b/i.test(String(stderr ?? ""))
}

/**
 * How a `tc tm add` that printed no report stopped: "nothing-saved" or "uncertain". Only
 * "nothing-saved" leaves the plan approvable; anything else may have saved some cases.
 *
 * The CLI prints its report as soon as it has started creating cases. So a process that ran
 * and exited by itself with an error, and printed no report, failed before saving (reading
 * the file, signing in, finding the project or folder). A process that never started saved
 * nothing too. A kill, a timeout, a crash (a Go panic) or a clean exit with no report could
 * have stopped mid-save.
 */
export function tmAddStop({ status, signal, errorCode, stderr } = {}) {
	if (tmAddSavedNothing(stderr)) return "nothing-saved"
	if (errorCode === "ENOENT" || errorCode === "EACCES") return "nothing-saved"
	if (signal || errorCode) return "uncertain"
	if (/\bpanic:|\bgoroutine \d+/.test(String(stderr ?? ""))) return "uncertain"
	return Number.isInteger(status) && status !== 0 ? "nothing-saved" : "uncertain"
}

/** A note for the reply when a go with edits had to generate again. */
export const EDITED_GO_NOTE =
	"Your go included changes, and saving the plan as it was can't apply them, so the cases were generated again with your changes as guidance. Check the list below; it may differ from the plan."
