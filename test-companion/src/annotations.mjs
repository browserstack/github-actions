/**
 * Putting each failing test on the diff.
 *
 * An annotation puts the failure on the line itself, in the files-changed
 * view the reviewer is already in, instead of sending them to the run logs.
 *
 * Two limitations, both easy to misread:
 *
 * The line is where the test is DECLARED, not where the assertion failed.
 * Playwright prints `file:line:col` for the declaration and nothing
 * machine-readable for the failing statement.
 *
 * The path comes from the reporter, relative to the test runner's root
 * (Playwright's `testDir`), while GitHub wants it relative to the repository
 * root. Those match in the common layout and differ when the suite lives in a
 * subdirectory; GitHub silently drops an annotation whose path it cannot
 * place.
 *
 * Reporters that print no locator at all (mocha, wdio) produce no
 * annotations. Every failure is named in the report either way.
 */

/**
 * GitHub rejects a check-run request carrying more than 50 annotations. A
 * suite with 300 failures must not lose the whole set to one rejected call, so
 * the list is cut rather than the request risked.
 */
export const MAX_ANNOTATIONS = 50

/**
 * Read the failing tests back out of the report.
 *
 * Needs its own reader because parseSummary builds an object, where repeated
 * keys collapse and only the last failing test would survive.
 *
 * The writer separates the name from the location with a TAB (see
 * RunSummary.Render in cli/pkg/cli/workflow/summary.go) because a test name is
 * whatever the reporter printed and may legitimately contain a colon, a path,
 * or something that looks exactly like a locator.
 */
export function parseFailedTests(reportText) {
	const out = []
	for (const line of String(reportText ?? "").split("\n")) {
		if (!line.startsWith("failed_test: ")) continue
		const [name, location] = line.slice("failed_test: ".length).split("\t")
		if (!name) continue
		if (!location) {
			out.push({ name })
			continue
		}
		const at = location.lastIndexOf(":")
		const lineNo = at === -1 ? NaN : Number(location.slice(at + 1))
		if (at > 0 && Number.isInteger(lineNo) && lineNo > 0) {
			out.push({ name, file: location.slice(0, at), line: lineNo })
		} else {
			out.push({ name, file: location })
		}
	}
	return out
}

/**
 * A path GitHub can actually annotate: inside the repository, relative to its
 * root. An absolute path annotates nothing, and one climbing out of the
 * checkout would point at a file that is not in the pull request at all.
 */
const insideTheRepo = (file) =>
	typeof file === "string" &&
	file.length > 0 &&
	!file.startsWith("/") &&
	!/^[A-Za-z]:[\\/]/.test(file) &&
	!file.split(/[\\/]/).includes("..")

/** Turn the failing tests into check-run annotations. */
export function buildAnnotations(failedTests) {
	const out = []
	for (const t of failedTests ?? []) {
		if (!insideTheRepo(t.file)) continue
		const known = Number.isInteger(t.line) && t.line > 0
		out.push({
			path: t.file,
			// GitHub requires a line. Without one the top of the file is the
			// only honest place left, and the message says why it is there so
			// nobody reads line 1 as the failing statement.
			start_line: known ? t.line : 1,
			end_line: known ? t.line : 1,
			annotation_level: "failure",
			title: "Test Companion",
			message: known
				? `${t.name} failed. This is where the test is declared; the assertion that failed may be further down.`
				: `${t.name} failed. The reporter did not say which line, so this is the top of the file.`,
		})
		if (out.length === MAX_ANNOTATIONS) break
	}
	return out
}
