/**
 * Check-run annotations for failing tests. The line is where the test is
 * declared, not the failing assertion. Paths are relative to the runner's root,
 * so GitHub drops them when the suite lives in a subdirectory.
 */

// GitHub rejects a check-run request with more than 50 annotations.
export const MAX_ANNOTATIONS = 50

// The CLI separates name and location with a tab, since a test name may contain colons.
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

const insideTheRepo = (file) =>
	typeof file === "string" &&
	file.length > 0 &&
	!file.startsWith("/") &&
	!/^[A-Za-z]:[\\/]/.test(file) &&
	!file.split(/[\\/]/).includes("..")

export function buildAnnotations(failedTests) {
	const out = []
	for (const t of failedTests ?? []) {
		if (!insideTheRepo(t.file)) continue
		const known = Number.isInteger(t.line) && t.line > 0
		out.push({
			path: t.file,
			// GitHub requires a line; fall back to 1 and say so in the message.
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
