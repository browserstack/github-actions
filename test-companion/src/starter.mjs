/**
 * The first run, when nothing is configured yet — STM-3663 FR-13.
 *
 * Without this, installing the Action into a repository with no
 * testcompanion-pipeline.yml produces a red build and the line
 * `open testcompanion-pipeline.yml: no such file or directory`. That is the
 * worst possible first impression: the person did nothing wrong, the build
 * broke, and the message names a file they have never heard of.
 *
 * FR-13 asks for the opposite — a clean pass, and the file they need, ready to
 * copy. Handled here rather than in the CLI because changing `tc workflow run`
 * to succeed on a missing config would quietly swallow a real misconfiguration
 * for every pipeline already relying on that error.
 */

/** The pipeline file we hand someone who has none. */
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

  # Ask for anything by commenting "@test-companion ..." on a pull request.
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

/**
 * The pull request that adds the starter settings file — FR-13.
 *
 * The detected framework is recorded when we can tell what it is, and left out
 * when we cannot — a starter naming Cypress at a Playwright shop would claim an
 * understanding we do not have.
 */
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

/**
 * Where the pipeline file lives.
 *
 * Mirrors effectiveConfigPath in cli/pkg/cli/commands/workflow.go exactly —
 * flag, then TC_PIPELINE_CONFIG, then the repository root. Checking a different
 * path than the CLI reads would be worse than not checking at all: the Action
 * would announce "nothing is configured" to a repository that is configured.
 */
export function pipelineConfigPath(configInput, env = {}) {
	const flag = (configInput ?? "").trim()
	if (flag) return flag
	const fromEnv = (env.TC_PIPELINE_CONFIG ?? "").trim()
	if (fromEnv) return fromEnv
	return "testcompanion-pipeline.yml"
}

/**
 * What the job page says when there is no pipeline file. Deliberately free of
 * the words "error" and "failed": nothing went wrong, there is just nothing to
 * run yet.
 */
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
 * Which branch the settings file is read from — STM-5434 FR-7.
 *
 * Read from the branch under test, a pull request can rewrite the rules for its
 * own run and be obeyed: switch itself from preview to live, delete its own
 * spending limit, or point its Test Management writes somewhere else. That is a
 * safety problem rather than a product one, and it gets considerably easier to
 * reach once a comment can start a run.
 *
 * FR-7: read from the default branch for every event, so an edit to the
 * settings takes effect only after someone merges it.
 *
 * Note the deliberate consequence: a pull request that ADDS the settings file
 * for the first time does not get picked up until it merges. That is the same
 * rule, and the alternative is the hole above.
 */
export function settingsRef(payload = {}, env = {}) {
	// Guessing "main" last is safe: the worst case is "no settings file", which
	// is a clean skip (FR-13), not a run obeying rules the pull request wrote.
	return payload?.repository?.default_branch || env.GITHUB_DEFAULT_BRANCH || "main"
}
