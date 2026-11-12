/**
 * A repository with no pipeline file gets a clean pass and a starter file to
 * copy, instead of a red build.
 */

export const STARTER_PIPELINE = `# Test Companion — what runs, and when.
#
# Every entry below is a JOB BINDING: a workflow, the event that starts it, and
# the limits it runs under. Delete what you do not want; nothing fires unless it
# is listed here.
#
# Everything starts in preview, which means Test Companion reports what it WOULD
# have done and writes nothing. Change a job to \`mode: live\` once you have seen
# a preview run you are happy with.

version: 1

workflows:
  # Generate test cases for the change in a pull request.
  - name: cases-for-this-pr
    workflow: generate
    on: pr_opened
    mode: preview
    limits:
      time: 20m
      credits: 300

  # Explain a red build. Runs only when a build actually failed.
  - name: explain-the-failure
    workflow: rca
    on: build_failed
    mode: preview
    limits:
      time: 20m
      credits: 300

  # Ask for anything by commenting "@browserstack ..." on a pull request.
  #
  # Live AND gated, which is the safe pairing rather than a contradiction: a
  # gated request first runs in preview to produce its proposal, and only a run
  # someone approved with "go" is allowed to write anything.
  - name: on-request
    workflow: test-pr
    on: pr_comment
    mode: live
    approval: review-before-run
    limits:
      time: 30m
      credits: 500
`

export function starterPipelineFor(framework) {
	const name = String(framework ?? "").trim()
	if (!name) return STARTER_PIPELINE
	return STARTER_PIPELINE.replace("version: 1", `# Detected test framework: ${name}.\nversion: 1`)
}

export function renderSetupPr(configPath, framework) {
	const name = String(framework ?? "").trim()
	return {
		branch: "test-companion-setup",
		title: "Add Test Companion settings",
		body: [
			`This adds \`${configPath}\`, which is where you say what Test Companion should run and when.`,
			...(name ? ["", `Your suite looks like **${name}**, which is recorded in the file.`] : []),
			"",
			"Nothing runs until this merges — the settings are deliberately read from the default branch, so a pull request cannot change the rules for its own run.",
			"",
			"Everything except the comment binding starts in preview, which reports what it would have done and writes nothing. Change a job to `mode: live` once you have seen a preview you are happy with.",
		].join("\n"),
	}
}

/** The pipeline file path. Must match the CLI's own resolution. */
export function pipelineConfigPath(configInput, env = {}) {
	const flag = (configInput ?? "").trim()
	if (flag) return flag
	const fromEnv = (env.TC_PIPELINE_CONFIG ?? "").trim()
	if (fromEnv) return fromEnv
	return "testcompanion-pipeline.yml"
}

export function renderNoPipelineReport(path) {
	return [
		"## Test Companion",
		"",
		`Nothing to run yet — this repository has no \`${path}\`, so no jobs are set up.`,
		"",
		`Add the file below to the root of the repository and Test Companion will start on the next pull request. Everything in it runs in **preview**, which reports what it would have done and writes nothing.`,
		"",
		"```yaml",
		STARTER_PIPELINE.trimEnd(),
		"```",
		"",
	].join("\n")
}

/**
 * Settings are read from the default branch, so a pull request cannot change
 * the rules for its own run.
 */
export function settingsRef(payload = {}, env = {}) {
	return payload?.repository?.default_branch || env.GITHUB_DEFAULT_BRANCH || "main"
}
