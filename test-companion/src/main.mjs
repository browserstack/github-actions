/**
 * The Action's entry point.
 *
 * Deliberately thin. Every decision worth testing lives in plan-run.mjs,
 * outcome.mjs and report.mjs, which are pure and run under `node --test` in
 * milliseconds. What is left here is I/O: read the event, spawn the CLI, call
 * GitHub, write the step's outputs. That split exists because the only other
 * way to test this is to push a commit and wait several minutes for a runner.
 *
 * Zero dependencies — Node's standard library plus `gh`, which is preinstalled
 * on every GitHub runner and is already how this product talks to GitHub.
 */
import { readFileSync, appendFileSync, writeFileSync, existsSync, rmSync, readdirSync, accessSync, mkdtempSync, lstatSync, constants } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { planRun, contextArgs, withPullRequestHead, TC_EVENTS } from "./plan-run.mjs"
import { readIntent, INTENT } from "./intent.mjs"
import { chooseRunsToCancel, runIdsFromChecks, latestFailedRun } from "./runs.mjs"
import { decideGate, GATE, describeChangeSize, ANSWER_JOBS } from "./gate.mjs"
import { mayAsk, describeTestRepoAccess } from "./access.mjs"
import { findTicket } from "./ticket.mjs"
import { childEnvFor } from "./child-env.mjs"
import { canIsolate, prepareSandbox, stopSandbox, handToAgent, writeAgentEnv, readAgentFile } from "./sandbox.mjs"
import { agentEnvFrom, asAgentCommand, checkPrHandoff, readClaimResult } from "./sandbox-policy.mjs"
import { startRelay } from "./relay.mjs"
import { runCapturingAnswer } from "./answer.mjs"
import { appCredentials, signJwt, installationTokenRequest } from "./app-auth.mjs"
import { OUTCOMES, parseSummary, resolveOutcome, checkConclusion, stepShouldFail, approvalWasSpent } from "./outcome.mjs"
import {
	renderJobSummary,
	renderCheckSummary,
	renderComment,
	chooseCommentAction,
	checkSha,
	checkSubjectFor,
	renderNotAuthorized,
	renderUnknownRequest,
	findProposal,
	renderProposal,
	renderExtraChecks,
	accessibilityFailsCheck,
	renderApprovedPlan,
	proposalDroppedMarkerFor,
	renderStopRemoved,
	proposalConsumedMarkerFor,
	proposalAlreadyUsed,
	proposalNeedsDropping,
	flattenPages,
	hasApproverEdits,
	renderProposalBody,
	isApprovableJob,
	findSupersededProposal,
	checkRequestFor,
	inFlightCheckId,
} from "./report.mjs"
import { pipelineConfigPath, renderNoPipelineReport, settingsRef, renderSetupPr, starterPipelineFor } from "./starter.mjs"
import { detectFramework } from "./framework.mjs"
import { buildAnnotations, parseFailedTests } from "./annotations.mjs"
import {
	shouldPushWork,
	changedPaths,
	splitPushable,
	renderPushNote,
	needsCheckout,
	isSameRepo,
	pushCredentialEnv,
	pushUrlFor,
	unexpectedConfigKeys,
	agentCommitted,
	CONFIG_READ_ARGS,
	trustedGitPath,
	trustedGhPath,
	ghEnvFrom,
	gitEnvFrom,
	GIT_SAFE_ARGS,
} from "./push-work.mjs"

const env = process.env
const REPO = env.GITHUB_REPOSITORY ?? ""
const RUN_URL = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${REPO}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`
// RUNNER_TEMP, not the system temp dir: GitHub clears RUNNER_TEMP per job, while
// /tmp survives on a self-hosted or reused runner. With fixed names in a shared
// /tmp, `existsSync(RESULT_FILE)` could find an EARLIER job's file and this run
// would report, and upload, test cases it never produced. Falls back to tmpdir
// so the Action still runs outside a GitHub runner.
const REPORT_DIR = env.RUNNER_TEMP || tmpdir()
const SUMMARY_FILE = join(REPORT_DIR, "test-companion-report.md")
// What the run PRODUCED, as opposed to how it went. Kept separate because the
// two have separate readers: a CI step branches on the summary, a person reads
// the result. For a preview run — which refuses to save by design — this file
// is the only place the generated cases survive.
const RESULT_FILE = join(REPORT_DIR, "test-companion-result.md")

// The artifact the result is uploaded under, named here so the report can
// point a reader at it by name. Must match the upload step in action.yml.
const RESULT_ARTIFACT = "test-companion-result"

const setOutput = (k, v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`)
const addToJobSummary = (md) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, md + "\n")
const notice = (m) => console.log(`::notice::${m}`)
const warn = (m) => console.log(`::warning::${m}`)

/**
 * The gh we run, found once, at load, BEFORE the agent runs. Looked up by
 * name instead, a `gh` the agent planted on PATH would be handed our token.
 * See trustedGhPath.
 */
const GH_BIN = trustedGhPath({
	exists: (p) => existsSync(p),
	canWrite: (p) => {
		try {
			accessSync(p, constants.W_OK)
			return true
		} catch {
			return false
		}
	},
})

/**
 * Every gh call in the Action goes through here, never through a bare
 * `spawnSync("gh", ...)`. A test checks that.
 *
 * Each call gets its own empty settings folder, made just before and removed
 * just after (see ghEnvFrom for why). The token is passed per call, so the
 * App's signed key never sits in any environment.
 */
function runGh(args, { token, input } = {}) {
	if (!GH_BIN) return { status: 1, stdout: "", stderr: "no trusted gh binary" }
	const configDir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "tc-gh-call-"))
	try {
		return spawnSync(GH_BIN, args, {
			encoding: "utf8",
			input,
			env: ghEnvFrom(env, { token, configDir }),
		})
	} finally {
		rmSync(configDir, { recursive: true, force: true })
	}
}

/** The raw `gh` call, so a caller that cares WHY it failed can look. */
function ghRaw(args, body) {
	return runGh(args, { token: env.GH_TOKEN, input: body ? JSON.stringify(body) : undefined })
}

/** `gh api`, returning parsed JSON or null. Never throws — reporting must not break a run. */
function gh(args, body) {
	const r = ghRaw(args, body)
	if (r.status !== 0) {
		// A missing permission is a normal, documented outcome: skip that
		// write, name it, carry on. It is never a reason to fail the run.
		warn(`GitHub API call failed (${args[1] ?? args[0]}): ${(r.stderr ?? "").trim().split("\n")[0]}`)
		return null
	}
	try {
		return JSON.parse(r.stdout)
	} catch {
		return null
	}
}

/**
 * Sign in as the Test Companion GitHub App, when it is installed.
 *
 * The comment and the tick then come from "Test Companion" rather than
 * github-actions[bot], and the workflow needs no permissions block because
 * the installation token carries the App's own.
 *
 * It does not run anything — the run still happens on the customer's machine
 * with their BrowserStack credentials.
 *
 * Every failure here falls back to the workflow token rather than stopping.
 * A repository without the App installed is the normal case, not an error.
 */
/**
 * The login this Action's comments appear under.
 *
 * `github-actions[bot]` with the workflow token; `<app-slug>[bot]` when the
 * App is installed. Used to tell OUR comments from any other bot's — "any
 * bot" would let another App post a proposal marker that a maintainer's `go`
 * then runs live.
 */
let botLogin = "github-actions[bot]"

/** HEAD before the agent ran, so a commit it made can be told from ours. */
let headBeforeRun = ""

/** Set when this run is carrying out an approved proposal, so the plan is marked spent. */
let consumedMarker = ""

/** What happened to a pull request the CLI handed back to open, for the comment. */
let handoffNote

/**
 * The CLI this job installed. Ours to run: it lives in the runner's home,
 * which the locked-down agent cannot reach. The agent gets its own copy.
 */
const TC_PATH = join(env.HOME ?? "", ".local", "bin", "tc")

/**
 * Whether to run the agent unisolated when it cannot be locked down. Off by
 * default: unisolated, the agent can reach every token and secret in the job.
 */
const ALLOW_UNISOLATED = /^true$/i.test(String(env.TC_ACTION_ALLOW_UNISOLATED ?? "").trim())

/**
 * The proposal this run is carrying out, so the report can link it.
 *
 * Approving one job no longer finishes off the
 * others on that commit, so two plans really can be waiting and "approved" on
 * its own no longer says which one this is.
 */
let approvedPlan

/**
 * Put the working tree on one commit.
 *
 * Never `--depth 1`: that SHALLOWS a clone the starter deliberately made with
 * `fetch-depth: 0`, so anything looking at history afterwards sees one
 * commit. The checkout's own result is checked, not just the fetch's.
 *
 * The URL is explicit and carries its own credential, because the starter
 * sets `persist-credentials: false` — the workflow token must not sit in
 * `.git/config` where a shell command the agent chose can read it.
 */
function fetchAndCheckout(sha, branch) {
	const url = pushUrlFor(REPO, env.GITHUB_SERVER_URL)
	if (!url || !sha) return false
	const cred = pushCredentialEnv(env.GH_TOKEN, url)
	if (!git(["fetch", url, sha], cred).ok) return false
	return branch ? git(["checkout", "-B", branch, sha]).ok : git(["checkout", "--detach", sha]).ok
}

function appInstallationToken() {
	const creds = appCredentials(env)
	if (!creds) return undefined
	// `creds` holds its own copy, so the key can leave
	// the environment the moment it has been read. Everything this process
	// starts from here on inherits that environment — including the agent,
	// which runs with --yolo and chooses its own commands — and a signing key
	// is not something to leave lying where they can read it.
	//
	// childEnvFor strips it for the agent already; this closes the same hole
	// for everything else, and does not rely on remembering to list it.
	delete env.TC_ACTION_APP_PRIVATE_KEY

	let jwt
	try {
		jwt = signJwt(creds)
	} catch (e) {
		// A malformed key is worth saying out loud: someone configured this and
		// it silently did nothing.
		warn(`Could not sign the GitHub App token (${e?.message ?? e}); using the workflow token instead.`)
		return undefined
	}

	// The JWT authenticates the APP; only the installation token can touch a
	// repository. Passed per-call rather than exported, so it never lands in
	// the environment at all.
	const asApp = (args) => runGh(args, { token: jwt })

	const found = asApp(["api", `repos/${REPO}/installation`])
	if (found.status !== 0) {
		notice("Test Companion: the GitHub App is not installed on this repository; using the workflow token.")
		return undefined
	}
	let installationId
	let appLogin
	try {
		const installation = JSON.parse(found.stdout)
		installationId = installation?.id
		// What WE post as. An App comments as
		// `<slug>[bot]`, and knowing that is what lets us tell our own
		// proposal from another App's.
		// Remembered here, but only adopted once a token is actually minted
		// (below). Adopted early, a failed mint left us posting as
		// github-actions[bot] while looking for our plans under the App's name.
		appLogin = installation?.app_slug ? `${installation.app_slug}[bot]` : undefined
	} catch {
		return undefined
	}
	if (!installationId) return undefined

	// "for that repo only". A token minted with no body carries every
	// permission the installation holds across every repository it covers — a
	// run in one repository would hold write access to all of an organisation's.
	const scope = installationTokenRequest(REPO)
	if (!scope) {
		warn(`Could not read "${REPO}" as owner/name, so no scoped App token was requested.`)
		return undefined
	}

	const mint = (body) =>
		runGh(["api", `app/installations/${installationId}/access_tokens`, "--method", "POST", "--input", "-"], {
			token: jwt,
			input: JSON.stringify(body),
		})

	// No retry with a smaller request. An installation granted fewer
	// permissions than we ask for refuses the whole request, and the old
	// retry dropped the permission list, which asks for EVERYTHING the
	// installation holds. If the App ever gained a permission, that retry
	// would hand it to a run that never needed it. The workflow token is
	// the safer fallback.
	const minted = mint(scope)
	if (minted.status !== 0) {
		warn(
			"Could not get a GitHub App token with the permissions Test Companion needs; using the workflow token instead. " +
				"If the App's permissions were changed, an organisation owner may need to accept them.",
		)
		return undefined
	}

	let token
	try {
		token = JSON.parse(minted.stdout)?.token
	} catch {
		return undefined
	}
	if (!token) return undefined

	// credentials are masked in the log. Before the token is used for
	// anything, so there is no window where it could be echoed unmasked.
	console.log(`::add-mask::${token}`)
	if (appLogin) botLogin = appLogin
	return token
}

/**
 * The settings file as it stands on the DEFAULT BRANCH, not the checked-out
 * tree.
 *
 * Read from the branch under test, a pull request could rewrite the rules for
 * its own run — switch itself from preview to live, delete its spending
 * limit, point its writes elsewhere.
 *
 * Returns the local path the content was written to, or undefined when there
 * is no settings file there. Fails SAFE: a fetch that errors is treated as
 * "no settings", a clean skip rather than a run governed by whatever happens
 * to be checked out.
 *
 * `--raw` because this is YAML, not the JSON envelope gh parses.
 */
function fetchSettings(path, ref) {
	const r = runGh(
		["api", `repos/${REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`, "-H", "Accept: application/vnd.github.raw"],
		{ token: env.GH_TOKEN },
	)
	if (r.status !== 0) {
		const first = (r.stderr ?? "").trim().split("\n")[0]
		// A 404 is the ordinary "this repo has no settings file yet" case.
		// Anything else is worth saying out loud, because the run is about to skip.
		if (!/404|Not Found/i.test(first)) warn(`Could not read ${path} from ${ref}: ${first}`)
		return undefined
	}
	const local = join(REPORT_DIR, "testcompanion-pipeline.default-branch.yml")
	writeFileSync(local, r.stdout)
	return local
}

/**
 * Whether `login` may ask Test Companion for a run.
 *
 * admin, maintain and write can; triage and read cannot. Any failure to get a
 * clear answer counts as "no".
 */
function hasWriteAccess(login) {
	if (!login) return false
	const res = gh(["api", `repos/${REPO}/collaborators/${login}/permission`])
	return ["admin", "maintain", "write"].includes(res?.permission)
}

/**
 * Is `login` on `team` in this repository's organisation?
 *
 * Tri-state on purpose: undefined means we could not find out (no token for
 * the organisation, API down, rate limited), which mayAsk treats as a no.
 */
function isOnTeam(login, team) {
	if (!login || !team) return undefined
	const org = REPO.split("/")[0]
	const res = gh(["api", `orgs/${org}/teams/${team}/memberships/${login}`])
	if (!res) return undefined
	return res.state === "active"
}

/**
 * Run git in the checkout. Never throws: every caller here treats a git
 * failure as "we could not save the work", which is reported, not fatal.
 */
/**
 * Resolved once, at module load — BEFORE the agent runs, so a `git` planted on
 * PATH later cannot be the one we find. Absent means we do not commit at all.
 */
const GIT_BIN = trustedGitPath({
	exists: (p) => existsSync(p),
	canWrite: (p) => {
		try {
			accessSync(p, constants.W_OK)
			return true
		} catch {
			return false
		}
	},
})

function git(args, extraEnv = {}) {
	// A near-empty environment, and no hooks. These run AFTER the agent, which
	// has had --yolo write access to the tree: a planted .git/hooks/pre-commit
	// would otherwise be executed by our own `git commit` with the App's
	// private key and the customer's credentials in its environment.
	if (!GIT_BIN) return { ok: false, out: "", raw: "", err: "no trusted git binary" }
	const r = spawnSync(GIT_BIN, [...GIT_SAFE_ARGS, ...args], {
		encoding: "utf8",
		env: { ...gitEnvFrom(env), ...extraEnv },
	})
	// `raw` is deliberate. `git status --porcelain` puts a SPACE in the first
	// column for an unstaged modification, and trimming the whole output eats
	// it on the first line, which once lost ten passing tests.
	// Anything parsing columns reads `raw`; everything else wants `out`.
	return { ok: r.status === 0, out: (r.stdout ?? "").trim(), raw: r.stdout ?? "", err: (r.stderr ?? "").trim() }
}

/**
 * The repository's default branch, or undefined when we cannot find out.
 * Undefined only relaxes the default-branch refusal, so an unanswered call
 * never widens anything else.
 */
function defaultBranchName() {
	return gh(["api", `repos/${REPO}`])?.default_branch
}

let cachedEvent
function readEvent() {
	// Parsed once. This is called seven times in a run, and the file cannot
	// change underneath us — GitHub writes it before the job starts.
	if (cachedEvent !== undefined) return cachedEvent
	cachedEvent = readEventUncached()
	return cachedEvent
}

function readEventUncached() {
	try {
		return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
	} catch {
		return {}
	}
}

/** Nothing to do. Report it plainly and let the step pass. */
function finishSkipped(reason, detail) {
	const human = {
		"not-a-pull-request": "That comment was on an issue, not a pull request.",
		"not-addressed-to-us": "No @browserstack mention, so nothing was asked of Test Companion.",
		"proposal-superseded": "The plan being approved was for an earlier commit, so it was not run.",
		"proposal-already-run": "That plan was already approved and run on this commit.",
		"proposal-dropped": "That plan was stopped, so there was nothing left to approve.",
		"nothing-failed": "Nothing has failed on this commit, so there was no build to look at.",
		"comment-edited": "Editing a comment does not start a run.",
		fork: "A pull request from a fork does not run with credentials until a maintainer asks for it.",
		draft: "Draft pull requests do not start a run on their own. Comment to ask for one.",
		"closed-unmerged": "The pull request was closed without merging.",
		"build-not-red": "That run did not fail, so there is nothing to explain.",
		"own-run": "That was Test Companion's own run; it does not explain itself.",
		"unsupported-event": "Test Companion is not bound to this kind of event.",
		"unsafe-context": "A value from this event looked like a command-line flag and was refused.",
		"no-workflow-named": "A manual run needs a `workflow` input naming the job.",
		"no-credentials": "Skipped: BrowserStack credentials are not available to this run.",
		"no-binding": "Nothing in testcompanion-pipeline.yml is bound to this event, so there was nothing to run.",
		// name the permission and the line to add. The commonest cause by
		// far is a workflow without `pull-requests: read` — the lookup 403s, the
		// head commit is unknown, and the run fails closed. Said plainly here
		// because "nothing safe to run against" sends a reader looking at their
		// pull request rather than at their permissions block.
		"no-pr-head":
			"Could not read that pull request, so there is no commit it is safe to run against. " +
			"If this workflow has no `pull-requests: read` permission, add it.",
		"not-authorized": "Only someone with write access to this repository can ask Test Companion for a run.",
		"unmapped-request": "That comment did not name anything Test Companion can do; it was answered in the thread.",
		stopped: "`stop` is no longer something Test Companion does; the reply says what to use instead.",
		"not-bound": "That job is not bound to pull request comments in this repository.",
		"nothing-to-approve": "Nothing is waiting for approval on this commit.",
		"proposal-not-found": "That reply named a plan that is not waiting on this commit.",
		"proposal-job-not-enabled": "That plan named a job this repository has not enabled, so it was not run.",
		"already-done": "This job already ran for this commit, so it was not run again.",
		"proposal-expired": "That proposal was more than a day old and has been dropped.",
		proposed: "Proposed, and waiting for someone to reply go.",
		"setup-requested": "Opened a pull request adding the settings file.",
	}[reason]
	const msg = human ?? `Nothing to do (${reason}).`
	notice(`Test Companion: ${msg}`)
	// The "in progress" check goes up before the CLI
	// runs, so the run is cancellable while it is going. Skipping out from
	// under it left "Test Companion" pending for ever — and `no-binding` is
	// most events, so for most repositories that was most runs.
	//
	// Completing it here rather than posting the check later is what keeps
	// that true. Nothing deliberately leaves a check pending through this
	// function: the proposal path posts its own and exits directly.
	for (const sha of checksMade.keys()) {
		postCheck(OUTCOMES.SKIPPED, { outcome: "Skipped", summary: {}, runUrl: RUN_URL }, sha, [], "completed", msg)
	}
	addToJobSummary(`## Test Companion\n\n${msg}${detail ? `\n\n\`${detail}\`` : ""}`)
	setOutput("outcome", "Skipped")
	setOutput("should-fail", "false")
	process.exit(0)
}

/**
 * no settings file means a clean pass and the file they need.
 *
 * Checked before anything else that could cost money or time. Left to the CLI
 * this is a red build reading `open testcompanion-pipeline.yml: no such file or
 * directory` — the person did nothing wrong, and the message names a file they
 * have never heard of.
 */
function finishWithStarter(path) {
	notice(`Test Companion: no ${path} yet, so there is nothing to run. A starter is on the run summary.`)
	addToJobSummary(renderNoPipelineReport(path))
	setOutput("outcome", "Skipped")
	setOutput("should-fail", "false")
	process.exit(0)
}

async function main() {
	// Without a gh we trust, nothing can be reported, so a run would finish
	// green and silent. Say so, and stop before anything is spent.
	if (!GH_BIN) {
		console.log(
			"::error::Test Companion could not find GitHub's gh command in a system folder this job cannot write to " +
				"(/usr/bin, /usr/local/bin, /opt/homebrew/bin or /bin). It will not run a gh found elsewhere, because " +
				"that copy could have been replaced. Install gh system-wide on this runner.",
		)
		process.exit(1)
	}

	// Release 4: act as the App when it is installed, so the comment and the
	// tick carry Test Companion's name. Before anything else talks to GitHub.
	const appToken = appInstallationToken()
	if (appToken) {
		env.GH_TOKEN = appToken
		notice("Test Companion: acting as the GitHub App.")
	}

	// a run without credentials does nothing, says so, and passes. This is
	// the normal shape of a fork pull request, not an error.
	if (!env.BROWSERSTACK_USERNAME || !env.BROWSERSTACK_ACCESS_KEY) {
		finishSkipped("no-credentials")
	}

	// Before the plan, so a repository with no pipeline file gets the starter
	// rather than whatever the planner happens to say about this event.
	const configPath = pipelineConfigPath(env.TC_ACTION_CONFIG, env)
	// from the default branch, never from the branch under test.
	// May be undefined — a repository with no settings file is a normal, and
	// very common, first run. It is NOT an early exit any more: a
	// comment asking us to add that file is the one thing worth doing in a
	// repository that has none, and the exit used to sit in front of it.
	// Nothing below costs money before the settings check further down.
	const settingsFile = fetchSettings(configPath, settingsRef(readEvent(), env))

	// before anything else this run does, clear out proposals that ran
	// out of time, so none of them leaves a check stuck on "in progress".
	if (settingsFile && env.GITHUB_EVENT_NAME === "schedule") sweepExpiredProposals()

	let plan = planRun({
		eventName: env.GITHUB_EVENT_NAME,
		payload: readEvent(),
		repo: REPO,
		sha: env.GITHUB_SHA,
		ref: env.GITHUB_REF,
		inputs: {
			workflow: env.TC_ACTION_WORKFLOW,
			preview: env.TC_ACTION_PREVIEW,
			"self-workflow-name": env.TC_ACTION_SELF_WORKFLOW,
		},
	})
	if (plan.skip) {
		// closing a pull request without merging stops whatever it started.
		if (plan.skip.reason === "closed-unmerged") cancelForClosedPr(readEvent())
		finishSkipped(plan.skip.reason, plan.skip.detail)
	}

	// Only someone who can write to the repository may ask for a run by
	// commenting. On a public repository anyone can comment, and a run runs an
	// agent with --yolo against the customer's own machine and credentials.
	//
	// Fails CLOSED: if the permission lookup itself fails — no token, API
	// down, rate limited — the run does not start.
	//
	// Keyed on the TRIGGER, not only on a flag the planner sets. A planner
	// change that forgot the flag would delete this gate silently, and runs
	// would simply start working for people who cannot start them.
	//
	// A comment names an issue, not a commit, so look the pull request up:
	// the run works on ITS head and the check lands on that commit. Fails
	// closed on a fork, like every other untrusted trigger.
	let pull
	if (!plan.context?.sha && plan.context?.pr) {
		pull = gh(["api", `repos/${REPO}/pulls/${plan.context.pr}`])
		plan = withPullRequestHead(plan, pull, REPO)
		if (plan.skip) finishSkipped(plan.skip, `PR #${plan.context.pr}`)
		// Work on the commit that was asked about. The starter checks out the
		// default branch for a comment event, since the payload names no ref.
		if (!fetchAndCheckout(plan.context.sha)) {
			warn(`Could not check out ${plan.context.sha}; running against the tree this job checked out.`)
		}
	}

	// the ticket this change is for, so the run tests against what the
	// ticket asks for and not only what the diff does. The pull request object
	// is already in hand for a comment event; for a pull_request event it is on
	// the payload.
	const prForTicket = pull ?? readEvent().pull_request
	const ticket = findTicket({
		title: prForTicket?.title,
		branch: plan.context?.branch ?? prForTicket?.head?.ref,
		body: prForTicket?.body,
	})
	if (ticket && plan.context) plan.context.ticket = ticket

	// Read once, before the access check: team narrowing lives in the
	// same document as approval gate.
	const bindingsDoc = settingsFile && plan.event ? readBindings(settingsFile, plan.event, plan.context?.branch) : undefined
	const askTeam = bindingsDoc?.settings?.ask_team

	// Only issue_comment. `pull_request_review_comment` was listed here too,
	// but route has no case for it, so such an event skips as
	// "unsupported-event" long before this line — and the starter does not
	// subscribe to it either.
	// Jobs that understand --propose-only and --plan-file. For anything else
	// the proposal IS the preview run's report.
	const CARRIES_A_PLAN = new Set(["test-pr"])
	// Jobs that cannot run without knowing which build failed.
	const NEEDS_A_BUILD = new Set(["rca", "fix", "verdict"])
	const COMMENT_TRIGGERS = new Set(["issue_comment"])
	if (COMMENT_TRIGGERS.has(env.GITHUB_EVENT_NAME) || plan.requiresWriteAccess) {
		const who = plan.commenter ?? readEvent().comment?.user?.login
		// write access is the floor, and the pipeline file may narrow it
		// to a team. It may never widen it — see mayAsk.
		const allowed = mayAsk({
			hasWriteAccess: hasWriteAccess(who),
			askTeam,
			inTeam: askTeam ? isOnTeam(who, askTeam) : undefined,
		})
		if (!allowed) {
			// A refusal wants a one-line reply, not a line in a log the person
			// who asked will never open.
			//
			// Unless they never addressed us. An unaddressed comment reaches
			// here only because it was a bare "go", and answering a bystander's
			// one-word comment with a public refusal is noise in someone else's
			// conversation.
			if (!plan.approvalOnly) replyOnPr(plan.context?.pr, renderNotAuthorized(who ?? "there", askTeam))
			finishSkipped("not-authorized", who)
		}
	}

	// work out what the comment actually asked for, here, before the CLI
	// is spawned — a request we cannot place has to cost nothing.
	let proposing = false
	let approvalNote = ""
	if (plan.event === TC_EVENTS.PR_COMMENT) {
		// pass what this repository has actually bound, so a job can be
		// asked for by name and not only by the phrases written into PHRASES.
		// Fetched BEFORE the intent is read, because what a reply means depends
		// on whether we asked a question: with a plan waiting, "go, and fix
		// case 3's title" is an approval with an edit, not a request to run
		// `fix`.
		const comments = flattenPages(gh(["api", `repos/${REPO}/issues/${plan.context.pr}/comments`, "--paginate", "--slurp"]))
		let waiting = findProposal(comments, plan.context.sha, Date.now(), botLogin)

		const enabledJobs = (bindingsDoc?.bindings ?? []).filter((b) => b.enabled).map((b) => b.workflow)
		const intent = readIntent(plan.context.instructions, {
			workflows: enabledJobs,
			proposalWaiting: Boolean(waiting),
		})

		if (intent.kind === INTENT.UNKNOWN) {
			replyOnPr(plan.context.pr, renderUnknownRequest())
			finishSkipped("unmapped-request")
		}
		// `stop` is gone. The word is still answered, because proposals already
		// in live threads tell people to say it; it just says what to do
		// instead and starts nothing.
		//
		// Still handled BEFORE the job words, for the reason it always was:
		// falling through would be the worst possible reading of "stop", where
		// the person asks for the run to end and a new one begins.
		if (intent.kind === INTENT.STOP) {
			replyOnPr(plan.context.pr, renderStopRemoved())
			finishSkipped("stopped")
		}
		if (intent.kind === INTENT.SETUP) {
			openSetupPr(plan, configPath)
			finishSkipped("setup-requested")
		}

		// `go #<id>` names WHICH plan. Resolved here because the intent is
		// what carries the number, and before
		// anything reads `waiting`, because from this point on it IS the plan
		// being approved.
		//
		// A number that matches nothing gets its own answer rather than the
		// generic "nothing is waiting": the person was specific, and telling
		// them the thread is empty when it is not would send them looking in
		// the wrong place.
		if (intent.kind === INTENT.GO && intent.proposalId) {
			waiting = findProposal(comments, plan.context.sha, Date.now(), botLogin, { id: intent.proposalId })
			if (!waiting) {
				replyOnPr(
					plan.context.pr,
					`I have no plan \`#${intent.proposalId}\` still waiting on \`${String(plan.context.sha).slice(0, 7)}\`. ` +
						`It may have been approved, dropped, or written against an earlier commit. ` +
						`Reply **go** on its own to approve the most recent one.`,
				)
				finishSkipped("proposal-not-found")
			}
		}

		// A named job narrows what the binding would otherwise choose. The event
		// is kept, so the binding still governs result mode and limits — asking
		// by comment must not be a way around the repository's own settings.
		if (intent.workflow) plan.workflow = intent.workflow

		const bindings = bindingsDoc
		const binding = pickBinding(bindings, intent.workflow)

		// A comment may only ask for a BOUND workflow. Saying so now beats a preview run,
		// a proposal, a "go", and only then "no binding for pr_comment".
		if (intent.workflow && bindings && !binding) {
			replyOnPr(
				plan.context.pr,
				`\`${intent.workflow}\` is not bound to pull request comments in this repository, so nothing ran. Bind it in \`${configPath}\` under \`on: pr_comment\`.`,
			)
			finishSkipped("not-bound", intent.workflow)
		}

		// An unaddressed comment only ever reaches us as a possible approval.
		// With nothing waiting, it is what it looked like: a person talking to
		// each other, not to us.
		//
		// Unless a plan we put up has been left behind by a newer commit. Then
		// they were talking to us, they used a word we accept, and telling them
		// "no @browserstack mention" is both wrong and unhelpful — the reason
		// is sitting in the comment history.
		if (plan.approvalOnly && !waiting) {
			// Already approved, or already stopped. Checked BEFORE the
			// superseded reading, which otherwise reaches for any older plan
			// still in the thread and tells the person their branch moved on
			// when it did not, on the very commit the plan had just been
			// approved and run against.
			const used = proposalAlreadyUsed(comments, plan.context.sha, botLogin, plan.workflow)
			if (used) {
				replyOnPr(
					plan.context.pr,
					used === "approved"
						? "That plan has already been approved and run on this commit — there is nothing left to approve. Ask me again and I will put up a fresh one."
						: "That plan was stopped, so there is nothing left to approve. Ask me again and I will put up a fresh one.",
				)
				finishSkipped(used === "approved" ? "proposal-already-run" : "proposal-dropped")
			}

			const stale = findSupersededProposal(comments, plan.context.sha, botLogin)
			if (stale) {
				replyOnPr(
					plan.context.pr,
					`That plan was for \`${String(stale.sha).slice(0, 7)}\`, and this branch has moved on since — ` +
						`a plan written against code that has changed is not safe to run. ` +
						`Ask me again and I will put up a fresh one for \`${String(plan.context.sha).slice(0, 7)}\`.`,
				)
				finishSkipped("proposal-superseded")
			}
			finishSkipped("not-addressed-to-us")
		}
		const gate = decideGate({
			intent,
			approval: binding?.approval,
			proposal: waiting,
			actor: plan.commenter ?? plan.context.actor,
			// Named by the comment when it named one, otherwise whatever the
			// binding would run — the gate needs the job that will ACTUALLY run.
			workflow: plan.workflow ?? binding?.workflow,
		})

		if (gate.action === GATE.NOTHING_TO_APPROVE) {
			replyOnPr(
				plan.context.pr,
				"There is nothing waiting for approval on this commit. Ask for a job by name and I will propose one.",
			)
			finishSkipped("nothing-to-approve")
		}
		if (gate.action === GATE.EXPIRED) {
			// dropped after 24 hours. Enforced on the approving side, so a
			// stale proposal cannot be approved however long it sits there.
			replyOnPr(
				plan.context.pr,
				"That proposal is more than a day old, so I have dropped it. Ask again and I will put up a fresh one.",
			)
			finishSkipped("proposal-expired")
		}

		if (gate.approvedProposal) {
			// Pin the run to the job that was actually proposed and read. The
			// GO intent names no workflow, so without this the CLI resolved one
			// from the event alone — whichever binding came first in the file
			// and a `fix` proposal could run something else, live, with --yolo.
			if (waiting?.workflow) {
				if (!isApprovableJob(waiting.workflow, enabledJobs)) {
					replyOnPr(
						plan.context.pr,
						"That plan names a job this repository does not have enabled, so I have not run it. Ask again and I will put up a fresh one.",
					)
					finishSkipped("proposal-job-not-enabled")
				}
				plan.workflow = waiting.workflow
			}

			// Adopt the check the PROPOSAL run left in progress. This run is a
			// different process with an empty memo, so without the lookup it
			// posts a SECOND check and the proposal's one stays pending beside
			// it for the life of the branch. The sweep already does this;
			// the approval path did not.
			const pending = inFlightCheckId(
				gh(["api", `repos/${REPO}/commits/${plan.context.sha}/check-runs?per_page=100`])?.check_runs,
			)
			if (pending) rememberCheck(plan.context.sha, pending)
			// Named with the JOB it finished. Without that, approving `fix`
			// leaves a waiting `generate` plan unapprovable until somebody
			// pushes.
			consumedMarker = proposalConsumedMarkerFor(plan.context.sha, plan.workflow)
			approvedPlan = waiting?.url ? { id: waiting.id, url: waiting.url } : undefined

			// the run carries out the approved plan — the proposal as the
			// approver left it, edits and all. Written to a file rather than
			// squeezed onto a command line: a case list is prose, and --context
			// strips the punctuation it is written with.
			const replyText = plan.context.instructions
			const planFile = join(REPORT_DIR, "approved-plan.md")
			writeFileSync(planFile, renderApprovedPlan(waiting?.body, replyText))
			if (CARRIES_A_PLAN.has(plan.workflow)) plan.context.plan_file = planFile

			// And the approving comment's own text stops here. The edits are in
			// the plan file now; passing the raw reply as well would put free
			// text back on the path to the agent, which is what made the approval
			// meaningless in the first place.
			delete plan.context.instructions

			// Reported, not refused. Both asking and approving need write access,
			// so one person doing both is not an escalation — but edits made at
			// approval time were reviewed by nobody but the approver, and on a
			// self-approved run by nobody at all. A reviewer should see that.
			if (gate.selfApproved) {
				approvalNote = hasApproverEdits(replyText)
					? ` Approved by @${plan.commenter}, who also asked for it — and edited the plan while approving, so nobody else reviewed those changes.`
					: ` Approved by @${plan.commenter}, who also asked for it.`
				notice(`Test Companion:${approvalNote}`)
			}
		} else {
			// too big to cover in one go — say so to the run, which then
			// covers what matters and lists what it left out.
			const size = describeChangeSize(pull)
			if (size.large) {
				plan.context.focus = `${size.files} files and ${size.lines} changed lines`
			}
		}

		proposing = gate.action === GATE.PROPOSE
		// a planning pass has to KNOW it is one. Without this it attempts
		// the work, is refused by preview, and reports "Could not run" after
		// spending real credits — observed on the first live run.
		// Only `test-pr` has --propose-only and --plan-file; sending either to
		// any other job is an unknown-flag exit before the run starts.
		//
		// The gate still works for them, because a proposal run is a PREVIEW
		// run and preview is enforced in tool dispatch: it does the work,
		// writes nothing, and its report is what the reviewer approves.
		if (proposing && CARRIES_A_PLAN.has(plan.workflow)) plan.context.propose_only = "true"
		if (gate.preview || intent.preview) plan.preview = true

		// THIS RUNS LAST, and it has to.
		//
		// `rca`, `fix` and `verdict` need to know WHICH build failed. A
		// build_failed trigger is handed the run; a comment is not.
		//
		// Last, because the workflow is not final until the approval handling
		// above has run: "go" names no job, so the job comes from the proposal
		// being approved. Higher up, asking for an rca would work and
		// APPROVING it would not — the CLI gets spawned with no build and
		// refuses with `rca requires --context build=<url|number>`.
		//
		// The newest red run on this commit is what a person means by "the
		// failure". Only looked up when the job needs it and the caller has
		// not already said.
		if (NEEDS_A_BUILD.has(plan.workflow) && !plan.context.build) {
			const runs = gh(["api", `repos/${REPO}/actions/runs?head_sha=${plan.context.sha}&per_page=100`])
			const failed = latestFailedRun(runs?.workflow_runs, {
				selfRunId: env.GITHUB_RUN_ID,
				selfWorkflowName: env.TC_ACTION_SELF_WORKFLOW,
			})
			if (!failed) {
				// Nothing red is an answer, not an error.
				replyOnPr(
					plan.context.pr,
					`Nothing has failed on \`${String(plan.context.sha).slice(0, 7)}\`, so there is no build for me to look at. Re-run me once something is red, or say what you want tested instead.`,
				)
				finishSkipped("nothing-failed", plan.workflow)
			}
			plan.context.build = failed
			notice(`Test Companion: reading the failure from ${failed}`)
		}
	}

	// no settings file means a clean pass and the file they need. Checked
	// before anything that costs money or time — the comment handling above
	// spends only API calls, and "set up this repo" has to be reachable from here.
	if (!settingsFile) {
		finishWithStarter(configPath)
	}


	// Put the tree on the commit under review, when nothing else already has.
	//
	// An `issue_comment` event checks out the DEFAULT branch, and a
	// `pull_request` event checks out the MERGE commit. Neither is the commit
	// the run is about, and the starter workflow cannot be amended once
	// customers have merged it, so the Action corrects its own checkout.
	//
	// No --depth: on a clone made with fetch-depth 0 a shallow fetch makes a
	// COMPLETE clone shallow, taking history away from the agent and from
	// tc's dedupe claim.
	//
	// Advisory. A checkout we cannot do is reported and the run continues
	// against whatever is here, because a proposal built from the diff is
	// still worth having. shouldPushWork re-checks before anything is pushed.
	if (
		plan.context.branch &&
		plan.context.sha &&
		needsCheckout({ headSha: git(["rev-parse", "HEAD"]).out, wantSha: plan.context.sha })
	) {
		const moved = fetchAndCheckout(plan.context.sha, plan.context.branch)
		if (moved) notice(`Working on ${plan.context.branch} at ${String(plan.context.sha).slice(0, 7)}.`)
		else warn(`Could not check out ${plan.context.branch}; the run sees whatever this job checked out.`)
	}

	const saving = shouldPushWork({
		preview: plan.preview,
		// From whichever source THIS trigger actually has. A comment names an
		// issue, so `pull` was fetched to resolve a head sha; a pull_request
		// event carries the head on its own payload and nothing is fetched.
		// Reading only `pull` refused every pull_request-triggered push.
		sameRepo: isSameRepo(prForTicket?.head?.repo?.full_name, REPO),
		branch: plan.context.branch,
		headAuthorEmail: git(["log", "-1", "--format=%ae"]).out,
		// The tree is put on the pull request's commit much earlier, where the
		// comment's issue number is resolved to a head sha. That fetch is
		// ADVISORY — it warns and carries on, so the proposal still gets built
		// from the diff — which makes this the check that the advisory step
		// actually worked. Pushing from a tree that is not the reviewed commit
		// would send the default branch's content to the pull request's branch.
		onWantedCommit: !needsCheckout({ headSha: git(["rev-parse", "HEAD"]).out, wantSha: plan.context.sha }),
		defaultBranch: defaultBranchName(),
	})
	if (plan.context.branch && !plan.preview && !saving.ok) {
		notice(`Nothing will be saved to ${plan.context.branch}: ${saving.why}.`)
	}

	// Lock the agent down before it starts: a separate user, no admin rights,
	// no way into this Action's process or the runner's files. See
	// sandbox-policy.mjs for what that closes. Set up AFTER the checkout, so
	// the tree it is given is the one under review.
	const sandbox = isolateAgent(plan)

	// A manual run names its job and carries no event, which is how the CLI is
	// told to ignore the bindings. An event-driven run does NOT name one:
	// which job an event runs is the pipeline file's decision, so the Action
	// passes only --event. Guessing a name here was the first live run's
	// failure — `no binding for "pr_opened" (workflow "test")`, because the
	// repository had bound `generate`.
	const args = ["workflow", "run"]
	if (plan.workflow) args.push(plan.workflow)
	if (plan.event) args.push("--event", plan.event)
	// One flag per pair. A single joined value is parsed by pflag with
	// encoding/csv, where one double quote anywhere — `Fix "Pay now" button`
	// fails the whole flag and the run reports "Could not run".
	// The run's files. When the agent is locked down, the ones it reads are
	// copies in its `in` folder and the ones it writes land in its `out`
	// folder; ours are in the runner's home, which it cannot reach.
	const runFiles = sandbox
		? {
				config: handToAgent(sandbox, settingsFile, "testcompanion-pipeline.yml"),
				summary: `${sandbox.out}/report.md`,
				result: `${sandbox.out}/result.md`,
				handoff: `${sandbox.out}/pr-handoff.json`,
			}
		: { config: settingsFile, summary: SUMMARY_FILE, result: RESULT_FILE }
	if (sandbox && plan.context.plan_file) plan.context.plan_file = handToAgent(sandbox, plan.context.plan_file, "approved-plan.md")
	args.push(...contextArgs(plan.context))
	if (plan.preview) args.push("--preview")
	// The fetched copy, not whatever the checkout holds.
	args.push("--config", runFiles.config)
	args.push("--json", "--yolo", "--summary-file", runFiles.summary, "--result-file", runFiles.result)

	// The "already running" marker. The locked-down agent has nothing to
	// write to GitHub with, so the Action plants the marker itself, before
	// the run, and tells the CLI it is held. A marker already there means
	// this job already ran for this commit.
	const claim = sandbox ? holdClaim(plan, settingsFile) : { held: false }
	if (claim.collision) finishSkipped("already-done", claim.workflow)
	if (claim.passFlag) args.push("--claim-held")

	// The handle anything cancelling this run needs — a pull request closed
	// without merging is the one left. Posted BEFORE the run, because
	// a check written at the end cannot help cancel the run that is writing
	// it. It also makes "the check shows while it runs" true for every
	// run rather than only a proposal.
	const checkSubject = checkSha(plan.context, {}, env.GITHUB_SHA)
	if (checkSubject) {
		postCheck(
			"Running",
			{ workflow: plan.workflow, outcome: "Running", summary: {}, runUrl: RUN_URL },
			checkSubject,
			[],
			"in_progress",
			plan.preview ? "Planning" : "Running",
		)
	}

	// Where HEAD was before the agent touched anything.
	headBeforeRun = git(["rev-parse", "HEAD"]).out
	notice(`tc ${args.join(" ")}`)
	// Both files are written by `tc` itself, and the result file only when the
	// run generates cases. Remove any stale copy first so a run that produces
	// nothing cannot report an earlier run's work as its own.
	for (const f of [SUMMARY_FILE, RESULT_FILE]) {
		try {
			rmSync(f, { force: true })
		} catch {
			// A temp file we cannot remove is not worth failing the run over; the
			// sha check on the summary is the backstop.
		}
	}
	// The GitHub token belongs to the Action's own reporting, never to the agent.
	// The run executes shell commands the model chooses; anything in this
	// environment is readable by them. Stripped rather than trusted, because the
	// product only scrubs these on BrowserStack-hosted runs, not a customer's
	// own machine.
	const run = sandbox ? await runLockedDown(sandbox, args, runFiles) : await runCapturingAnswer("tc", args, childEnvFor(env))
	const exitCode = run.status ?? 1

	if (sandbox) {
		// Stop anything the agent left running before reading its files or
		// saving its work, then bring its files over to where the rest of this
		// Action (and the upload steps) expect them.
		stopSandbox(sandbox)
		for (const [from, to] of [
			[runFiles.summary, SUMMARY_FILE],
			[runFiles.result, RESULT_FILE],
		]) {
			const text = readAgentFile(from)
			if (text !== undefined) writeFileSync(to, text)
		}
		if (claim.held && exitCode !== 0) releaseClaim(claim)
		if (!plan.preview) handoffNote = openHandedOffPr(runFiles.handoff, plan)
	}

	// The report is absent whenever the process was killed, so treat it as a
	// real case rather than assuming it is there.
	let summaryText
	try {
		summaryText = readFileSync(SUMMARY_FILE, "utf8")
	} catch {
		summaryText = undefined
	}
	const summary = parseSummary(summaryText)
	// Read separately from parseSummary, which builds an object: repeated
	// `failed_test:` keys would collapse to the last one.
	const failedTests = parseFailedTests(summaryText)
	const outcome = resolveOutcome(exitCode, summary)

	// Nothing was bound to this event. Finish the way every other "nothing to
	// do" finishes — no check, no comment, green step — rather than reporting a
	// run that never happened. The starter subscribes to every trigger, so for
	// most repositories most events land here.
	if (outcome === OUTCOMES.SKIPPED) {
		finishSkipped("no-binding", summary.event)
	}
	// Absent whenever the run generated nothing, which is most workflows. Its
	// presence is what tells the report there is something to point a reader at.
	const hasResult = existsSync(RESULT_FILE)
	const readResult = () => {
		try {
			return readFileSync(RESULT_FILE, "utf8")
		} catch {
			// Best effort, exactly as the CLI treats writing it: a report we
			// cannot read back is not worth failing a finished run over.
			return undefined
		}
	}

	// a configured write that could not happen is said out loud, naming
	// what is missing — a silent skip reads as "there was nothing to write".
	const warnings = []
	const testsRepo = bindingsDoc?.settings?.tests_repo
	if (testsRepo) {
		const probe = gh(["api", `repos/${testsRepo}`])
		const access = describeTestRepoAccess({ testsRepo, thisRepo: REPO, canPush: probe?.permissions?.push })
		if (!access.ok) warnings.push(access.message)
	}

	// silent unless the settings asked for them.
	const extraChecks = renderExtraChecks(summary, {
		wcag: bindingsDoc?.settings?.wcag,
		visual: bindingsDoc?.settings?.visual,
	})

	// the approved work must outlive the runner. Until this existed
	// nothing carried it off the machine — the CLI opens a pull request only
	// for `automate` and `fix`, so an approved `test-pr` run wrote eight
	// passing tests and lost all eight.
	// automate and fix hand back a pull request to open rather than work to
	// save on this branch; when they did, that is what the comment reports.
	const workNote = handoffNote ?? saveWork(saving, plan)

	const view = {
		workflow: plan.workflow ?? summary.workflow,
		// Which plan this run carried out — undefined on a run nobody approved.
		approvedPlan,
		workNote,
		extraChecks,
		warnings,
		outcome,
		summary,
		runUrl: RUN_URL,
		// two runs a week apart on the same pinned version must report the
		// same CLI version, which means showing it.
		cliVersion: summary.cli_version || env.TC_ACTION_CLI_VERSION,
		resultArtifact: hasResult ? RESULT_ARTIFACT : undefined,
		// Which request this answers. The comment is edited in place, so on a
		// pull request where several people have asked for different things,
		// nothing otherwise said whose question the current contents answer.
		askedBy: plan.commenter,
		askedAt: plan.askedAt,
		// `rca` and `verdict` leave no artefact — their result file holds the
		// agent's closing words, and that IS what was asked for. Without this
		// the comment is a table saying "Succeeded" with no answer in it.
		//
		// The closing words are read from the output stream for EVERY job, so
		// `fix` does not post a "Succeeded" table with its diagnosis nowhere
		// in sight. The result file stays as the fallback for the two verbs
		// the CLI writes it for, so a stream we fail to parse cannot lose
		// what worked.
		//
		// Still gated on ANSWER_JOBS: for `generate` that file holds test
		// cases, not prose.
		answer: run.answer || (hasResult && ANSWER_JOBS.has(plan.workflow ?? summary.workflow) ? readResult() : undefined),
		failedTests,
	}
	// a held request posts what it WOULD do and ends. The run that
	// produced this was a preview run, so nothing has been written.
	if (proposing) {
		const sha = checkSha(plan.context, summary, env.GITHUB_SHA)
		addToJobSummary(renderJobSummary(view))
		// say when the change is too big to test in one go, so the
		// reviewer can narrow the list before approving rather than after.
		const size = describeChangeSize(pull)
		const sizeNote = size.large
			? `> **This is a large change** — ${size.files} files and ${size.lines} changed lines. Trim the list below before replying go if you only want part of it covered.\n\n`
			: ""
		// The plan itself, which the run writes to the result file. Without it
		// the proposal is a report header and nothing to review.
		let planBody = ""
		try {
			planBody = readFileSync(RESULT_FILE, "utf8")
		} catch {
			// No result file means the run produced no plan; renderProposalBody
			// says so rather than rendering an empty proposal.
		}
		replyOnPr(
			plan.context.pr,
			renderProposal(
				// The same cap, for the same reason: this body is a comment, and
				// an over-long one does not truncate — it fails to post, taking
				// the whole proposal with it.
				renderProposalBody({ summary: renderCheckSummary(view), plan: planBody, sizeNote }),
				sha,
				plan.commenter,
				// record WHICH job this proposal is for, so approving it
				// cannot run a different one.
				plan.workflow ?? summary.workflow,
			),
		)
		// the check shows in progress while the proposal waits.
		postCheck(outcome, view, sha, [], "in_progress")
		setOutput("outcome", "Proposed")
		setOutput("should-fail", "false")
		process.exit(0)
	}

	addToJobSummary(renderJobSummary(view))
	if (summaryText) setOutput("summary-file", SUMMARY_FILE)
	if (hasResult) setOutput("result-file", RESULT_FILE)
	setOutput("outcome", outcome)
	setOutput("should-fail", String(stepShouldFail(env.TC_ACTION_BUILD_EFFECT, outcome)))

	// each failing test on the line it is declared on, so a reviewer sees
	// it in the files-changed view instead of having to open the run's logs.
	// Empty whenever the reporter printed no locator, which is every mocha run
	// those failures are named in the report instead.
	const annotations = buildAnnotations(failedTests)
	// accessibility may turn the check red, but ONLY when the settings
	// say so and only for violations this change introduced. The step's own
	// result is untouched — that follows the build effect.
	const checkOutcome =
		outcome === OUTCOMES.SUCCEEDED &&
		accessibilityFailsCheck(summary, {
			wcag: bindingsDoc?.settings?.wcag,
			failOnNew: bindingsDoc?.settings?.fail_on_new,
		})
			? OUTCOMES.TESTS_FAILED
			: outcome
	postCheck(checkOutcome, view, checkSha(plan.context, summary, env.GITHUB_SHA), annotations)
	// Mark the plan spent only if a run actually happened. A run that broke
	// before doing anything used to spend it anyway, which left the commit
	// permanently unapprovable. See approvalWasSpent.
	// On the PROPOSAL, before the comment: the proposal outlives every later
	// run, and the shared comment does not.
	if (approvalWasSpent(outcome)) markPlanSpent(approvedPlan?.id, consumedMarker)
	if (plan.context.pr)
		postComment(plan.context.pr, {
			...view,
			approvalNote,
			consumedMarker: approvalWasSpent(outcome) ? consumedMarker : "",
		})

	// Always exit 0. Whether the build goes red is the build effect's call, and
	// a separate step applies it — otherwise the report never gets attached.
	process.exit(0)
}

/**
 * Commit what the run wrote, onto the pull request's own branch.
 *
 * A commit on the branch rather than a second pull request: someone who asked
 * for tests on their change wants them on their change, not in a review queue
 * behind it.
 *
 * Returns the line for the comment, or undefined when there was nothing to
 * save. Never throws and never fails the run — a failed push that takes the
 * whole run down loses the report too.
 */
function saveWork(saving, plan) {
	if (!saving.ok) return undefined
	const branch = plan.context.branch
	// We push HEAD, so a commit the AGENT made rides
	// along unfiltered — source, lockfiles, `.github/` — and a workflow-file
	// change fails the whole push with an error nobody can read. Our own
	// commit happens below, after this check, so a HEAD that moved during the
	// run was not us.
	if (agentCommitted(headBeforeRun, git(["rev-parse", "HEAD"]).out)) {
		return [
			`**Could not save this work to \`${branch}\`:** the run committed to this branch itself,`,
			"so what is on HEAD is not what Test Companion chose to write. Nothing was pushed —",
			"the run's changes are in the job's workspace only.",
		].join(" ")
	}
	if (!GIT_BIN) {
		return `**Could not save this work to \`${branch}\`:** no trusted \`git\` was found on this runner (looked for a root-owned /usr/bin/git and /bin/git). Nothing was committed or pushed.`
	}

	// .git/config decides whether git runs a program for us and where a push
	// ends up, and the agent has just had --yolo write access to it. An
	// ordinary actions/checkout never sets any of the keys this looks for, so
	// one being present means the config was changed after the checkout.
	//
	// This runs before `git status`, because status can run a clean filter
	// itself — by the time we have a file list it is already too late.
	const unexpected = unexpectedConfigKeys(git(CONFIG_READ_ARGS).raw)
	if (unexpected.length) {
		return [
			`**Could not save this work to \`${branch}\`:** the repository's git config carries`,
			`${unexpected.map((k) => `\`${k}\``).join(", ")}, which \`actions/checkout\` does not write. Config is`,
			'where git keeps its "run this program" hooks and its URL rewrites, so Test Companion will not',
			"commit against a config it does not recognise. Nothing was committed or pushed — the run's",
			"changes are in the job's workspace only.",
		].join(" ")
	}
	// `-c core.quotePath=false` stops git octal-escaping non-ASCII bytes, so a
	// path like café.spec.ts arrives as itself. unquote decodes the escapes
	// anyway, but not producing them is the better half of the fix.
	// `-uall` so a NEW DIRECTORY arrives as its files. Without it git reports
	// `?? tests/`, splitPushable sees one path with one segment, and
	// `git add tests/` commits `tests/.env` and `tests/run.log` along with the
	// spec.
	const status = git(["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"])
	if (!status.ok) return undefined
	const { push, skip } = splitPushable(changedPaths(status.raw), {
		isSymlink: (p) => {
			try {
				return lstatSync(p).isSymbolicLink()
			} catch {
				// Gone (a deletion) or unreadable: not a link we would be adding.
				return false
			}
		},
	})
	if (push.length === 0) return undefined

	// Named paths, never `git add -A`: the agent ran shell commands of its own
	// choosing and the tree may hold anything. Adding only what we listed is
	// also what makes the comment's file list true by construction.
	const added = git(["add", "--", ...push])
	if (!added.ok) return renderPushNote({ branch, files: push, skipped: skip, error: added.err || "git add failed" })

	const subject = `test: ${plan.workflow ?? "Test Companion"} on ${String(plan.context.sha ?? "").slice(0, 7)}`
	const body = [
		subject,
		"",
		`Written by Test Companion for ${plan.context.pr ? `#${plan.context.pr}` : plan.context.sha}.`,
		`Run: ${RUN_URL}`,
	].join("\n")
	const committed = git(["commit", "-m", body])
	if (!committed.ok) {
		return renderPushNote({
			branch,
			files: push,
			skipped: skip,
			error: committed.err || committed.out || "nothing to commit",
		})
	}

	// Authenticate as the App when it is installed. Without this the push
	// uses whatever actions/checkout left in .git/config, so a team that
	// deleted the permissions block as we advise got a 403.
	//
	// The URL is built here from GITHUB_REPOSITORY rather than taken from the
	// remote named `origin`. The agent has had write access to this tree, and
	// `url.<base>.insteadOf` in .git/config silently redirects `origin` to any
	// host — which would hand the App token to it. The credential header is
	// scoped to this exact URL for the same reason.
	const target = pushUrlFor(REPO, env.GITHUB_SERVER_URL)
	if (!target)
		return renderPushNote({ branch, files: push, skipped: skip, error: `cannot push: bad repository name "${REPO}"` })
	const pushed = git(["push", target, `HEAD:refs/heads/${branch}`], pushCredentialEnv(env.GH_TOKEN, target))
	if (!pushed.ok) {
		// The one failure worth spelling out, because it is a settings problem
		// rather than a bug: the workflow's token is read-only by default.
		const hint = /403|permission|denied|protected/i.test(pushed.err)
			? `${pushed.err} — the job needs \`permissions: contents: write\`, and the branch must not be protected against it.`
			: pushed.err || "git push failed"
		return renderPushNote({ branch, files: push, skipped: skip, error: hint })
	}
	return renderPushNote({ branch, sha: git(["rev-parse", "HEAD"]).out, files: push, skipped: skip })
}

/**
 * Set up the locked-down user, or decide what to do when we cannot.
 *
 * Returns the sandbox layout, or undefined when the run goes ahead
 * unisolated because the workflow asked for that. Otherwise stops the run:
 * running an AI agent that can reach the job's tokens is not a default.
 */
function isolateAgent(plan) {
	const can = canIsolate()
	let why = can.why
	if (can.ok) {
		try {
			const layout = prepareSandbox({ repoDir: process.cwd(), tcPath: TC_PATH })
			notice("Test Companion: the agent runs as a separate, locked-down user with no access to this job's tokens.")
			return layout
		} catch (e) {
			why = e?.message ?? String(e)
		}
	}
	if (ALLOW_UNISOLATED) {
		warn(
			`Test Companion could not lock the agent down (${why}). allow-unisolated is set, so it runs as this job's own user and can reach this job's tokens and secrets.`,
		)
		return undefined
	}
	const message =
		`Test Companion did not run: it could not run the agent as a separate, locked-down user (${why}). ` +
		"Without that, the agent could reach this job's tokens and secrets. GitHub's own Linux runners support it. " +
		"On your own runner, give the job password-free sudo, or set `allow-unisolated: true` to accept the risk."
	console.log(`::error::${message}`)
	if (plan?.context?.pr) replyOnPr(plan.context.pr, message)
	setOutput("outcome", OUTCOMES.COULD_NOT_RUN)
	setOutput("should-fail", "true")
	process.exit(1)
}

/**
 * What the installed CLI can do, asked once. An older CLI still claims and
 * opens pull requests itself, which a locked-down agent cannot.
 */
let cliAbilities
function cliSupports() {
	if (cliAbilities) return cliAbilities
	const ask = (args) => spawnSync(TC_PATH, args, { encoding: "utf8", env: childEnvFor(env), timeout: 60_000 })
	const run = ask(["workflow", "run", "--help"])
	const claim = ask(["workflow", "claim", "--help"])
	const runHelp = `${run.stdout ?? ""}${run.stderr ?? ""}`
	cliAbilities = {
		claimHeld: /--claim-held/.test(runHelp),
		prHandoff: /--pr-handoff/.test(runHelp),
		// An unknown subcommand prints the parent's help and exits 0, so look
		// for a flag only the claim command has.
		claimCommand: /--release/.test(`${claim.stdout ?? ""}${claim.stderr ?? ""}`),
	}
	return cliAbilities
}

/**
 * Plant the "already running" marker for this job and commit, as this
 * Action, before the agent starts.
 *
 * Returns { collision, workflow } when the job already ran for this commit;
 * otherwise { held, passFlag }: whether we hold a marker to release on
 * failure, and whether to tell the CLI the marker is taken care of.
 */
function holdClaim(plan, settingsFile) {
	const can = cliSupports()
	if (!can.claimHeld || !can.claimCommand) {
		warn(
			"This version of the Test Companion CLI cannot hand its GitHub writes to the Action, so a live generate, automate or fix run may not be able to save its work. Update the CLI.",
		)
		return { held: false, passFlag: false }
	}
	// Preview writes nothing, the marker included. No commit, no marker.
	if (plan.preview || !plan.context.sha) return { held: false, passFlag: true }
	const args = [
		"workflow",
		"claim",
		...(plan.workflow ? [plan.workflow] : []),
		...(plan.event ? ["--event", plan.event] : []),
		...contextArgs(plan.context),
		"--config",
		settingsFile,
		"--sha",
		plan.context.sha,
	]
	const r = spawnSync(TC_PATH, args, { encoding: "utf8", env: childEnvFor(env), timeout: 120_000 })
	const got = readClaimResult(r.stdout, r.status)
	if (got.result === "collision") return { collision: true, workflow: got.workflow }
	if (got.result === "claimed") return { held: true, passFlag: true, args }
	if (got.result === "error") {
		const first = String(r.stderr ?? "")
			.trim()
			.split("\n")[0]
		warn(
			`Could not plant the "already running" marker${first ? ` (${first})` : ""}. Carrying on without it, so a second run on this commit is not stopped from repeating the work.`,
		)
	}
	return { held: false, passFlag: true }
}

/** Give the marker back after a run that did not succeed, so a retry can run. */
function releaseClaim(claim) {
	const r = spawnSync(TC_PATH, [...claim.args, "--release"], { encoding: "utf8", env: childEnvFor(env), timeout: 60_000 })
	if (r.status !== 0) {
		warn('Could not remove this run\'s "already running" marker, so a retry on this commit may be told the job already ran.')
	}
}

/**
 * The node binary the agent's launcher runs with. Ours, unless it lives in
 * the runner's home (the runner's own bundled node), which the agent cannot
 * reach: then a copy goes in the agent's `in` folder.
 */
function nodeForAgent(sandbox) {
	const home = String(env.HOME ?? "")
	if (!home || !process.execPath.startsWith(`${home}/`)) return process.execPath
	return handToAgent(sandbox, process.execPath, "node")
}

/**
 * Run the CLI as the locked-down user, with the read-only GitHub relay up
 * for the length of the run. Same result shape as runCapturingAnswer.
 */
async function runLockedDown(sandbox, args, runFiles) {
	const extra = {}
	if (cliSupports().prHandoff) extra.TC_WORKFLOW_PR_HANDOFF = runFiles.handoff
	const agentEnv = agentEnvFrom(childEnvFor(env), sandbox, extra)
	const node = nodeForAgent(sandbox)
	const relay = await startRelay({
		socketPath: sandbox.socket,
		token: env.GH_TOKEN,
		log: (line) => notice(`Test Companion's GitHub relay ${line}`),
	}).catch((e) => {
		warn(`The read-only GitHub relay did not start (${e?.message ?? e}), so the agent cannot read from GitHub in this run.`)
		return undefined
	})
	try {
		// Signed in to BrowserStack as the agent's own user, the same way the
		// Sign in step did it for ours. Best effort: the CLI also reads the
		// credentials from its environment.
		const login = asAgentCommand({
			node,
			launcher: sandbox.launcher,
			envFile: writeAgentEnv(sandbox, agentEnv, "login-env.json"),
			cwd: sandbox.work,
			command: `${sandbox.bin}/tc`,
			args: ["auth", "login"],
		})
		spawnSync(login.command, login.args, { stdio: "inherit", timeout: 120_000, env: { PATH: "/usr/bin:/bin" } })

		const cmd = asAgentCommand({
			node,
			launcher: sandbox.launcher,
			envFile: writeAgentEnv(sandbox, agentEnv),
			cwd: sandbox.work,
			command: `${sandbox.bin}/tc`,
			args,
		})
		return await runCapturingAnswer(cmd.command, cmd.args, { PATH: "/usr/bin:/bin" })
	} finally {
		await relay?.close()
	}
}

/**
 * Open the pull request automate or fix handed back, as this Action.
 *
 * The branch and its commits were made by the agent, so they get the same
 * refusals as saving work: an untouched git config, and no `.github/` files
 * or symlinks. Then the branch is pushed to a URL we build ourselves and the
 * pull request is opened. Returns the line for the comment, or undefined
 * when nothing was handed back.
 */
function openHandedOffPr(path, plan) {
	const text = readAgentFile(path, 256 * 1024)
	if (text === undefined) return undefined
	const req = checkPrHandoff(text, { sha: plan.context.sha })
	if (req.error) return `**Did not open a pull request:** ${req.error}.`
	if (!GIT_BIN) return "**Could not open the pull request:** no trusted `git` was found on this runner."
	const unexpected = unexpectedConfigKeys(git(CONFIG_READ_ARGS).raw)
	if (unexpected.length) {
		return `**Did not open a pull request:** the repository's git config carries ${unexpected.map((k) => `\`${k}\``).join(", ")}, which \`actions/checkout\` does not write.`
	}
	const tip = git(["rev-parse", "--verify", "--quiet", `refs/heads/${req.branch}^{commit}`])
	if (!tip.ok || !tip.out) return `**Did not open a pull request:** the run did not leave a \`${req.branch}\` branch.`
	const from = git(["merge-base", headBeforeRun || "HEAD", tip.out])
	if (!from.ok) return `**Did not open a pull request:** \`${req.branch}\` does not share history with this commit.`
	// --raw shows each file's new mode, so a symlink (120000) is caught from
	// the commit itself rather than from whatever is on disk now.
	const diff = git(["-c", "core.quotePath=false", "diff", "--raw", "--no-renames", "-z", from.out, tip.out])
	if (!diff.ok) return `**Could not open the pull request:** ${diff.err || "could not list its changes"}.`
	const fields = diff.raw.split("\0").filter(Boolean)
	const links = new Set()
	const paths = []
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const meta = fields[i].split(" ")
		paths.push(fields[i + 1])
		if (meta[1] === "120000") links.add(fields[i + 1])
	}
	const { skip } = splitPushable(paths, { isSymlink: (p) => links.has(p) })
	if (skip.length) {
		return `**Did not open a pull request:** the branch changes files Test Companion never pushes: ${skip.map((f) => `\`${f}\``).join(", ")}.`
	}
	const target = pushUrlFor(REPO, env.GITHUB_SERVER_URL)
	if (!target) return `**Could not open the pull request:** bad repository name "${REPO}".`
	const pushed = git(["push", target, `${tip.out}:refs/heads/${req.branch}`], pushCredentialEnv(env.GH_TOKEN, target))
	if (!pushed.ok) {
		return /rejected|non-fast-forward|already exists/i.test(pushed.err)
			? `**Already done:** \`${req.branch}\` already exists, so this job's pull request was opened by an earlier run.`
			: `**Could not open the pull request:** ${pushed.err || "git push failed"}.`
	}
	const opened = ghRaw(["api", `repos/${REPO}/pulls`, "--method", "POST", "--input", "-"], {
		head: req.branch,
		base: req.base,
		title: req.title,
		body: req.body,
	})
	if (opened.status !== 0) {
		return /already exists/i.test(`${opened.stdout}${opened.stderr}`)
			? `**Already done:** a pull request for \`${req.branch}\` is already open.`
			: `**Pushed \`${req.branch}\` but could not open the pull request:** ${String(opened.stderr ?? "").trim().split("\n")[0]}.`
	}
	let url = ""
	try {
		url = JSON.parse(opened.stdout)?.html_url ?? ""
	} catch {
		// Opened; the link is a nicety.
	}
	return `**Opened a pull request** with this run's changes${url ? `: ${url}` : ` from \`${req.branch}\``}.`
}

/** one check, never neutral.: each failing test on its own line. */
function postCheck(outcome, view, sha, annotations = [], status = "completed", title = undefined) {
	if (!sha) return
	const waiting = status === "in_progress"
	const payload = {
		name: "Test Companion",
		head_sha: sha,
		status,
		// Which run this check belongs to. The closed-PR cancel reads it back: the
		// check is posted on the PULL REQUEST's head commit, which is the one
		// thing that reliably ties a run to the pull request it is about.
		external_id: String(env.GITHUB_RUN_ID ?? ""),
		details_url: RUN_URL,
		output: {
			title: waiting ? (title ?? "Waiting for approval") : outcome,
			// CAPPED. GitHub rejects a summary over 65,535 characters with a
			// 422, gh turns that into a warning and returns null, and the
			// "Running" check posted before the run is then never completed
			// it sits in_progress on the head commit for ever, blocking anyone
			// who made it required. The comment was capped and this was not
			//
			summary: renderCheckSummary(view),
			...(annotations.length ? { annotations } : {}),
		},
	}
	// A check that is still running must carry no conclusion; GitHub rejects it.
	if (!waiting) payload.conclusion = checkConclusion(outcome)

	// Update the check this run already made for this commit, rather than
	// adding another. A run posts up to three times — in progress, the result,
	// and the catch-all on a crash — so posting every time left two or three
	// checks of the same name, and a proposal's in-progress one pending
	// forever. asks for one.
	const { method, path } = checkRequestFor(sha, checksMade)
	const res = gh(["api", `repos/${REPO}/${path}`, "--method", method, "--input", "-"], payload)
	if (res?.id) checksMade.set(sha, res.id)
}

/** The check this run has already created, per commit. See checkRequestFor. */
const checksMade = new Map()

/** Adopt a check another run created, so we update it instead of adding one. */
function rememberCheck(sha, id) {
	checksMade.set(sha, id)
}

/**
 * End the runs in flight on this commit.
 *
 * A cancel call rather than a flag the next run would notice: asking GitHub to
 * cancel is the only thing that stops work already underway. The one caller
 * left is a pull request closed without merging; `stop` was the other, and it
 * was removed.
 */
function cancelRunsOn(sha) {
	// Our own check runs on this commit, NOT `actions/runs?head_sha=`. A run
	// started by an issue_comment carries the DEFAULT BRANCH's sha, so that
	// query matched nothing and a closed pull request never cancelled anything
	// (verified live, 2026-10-29).
	const checks = gh(["api", `repos/${REPO}/commits/${sha}/check-runs?per_page=100`])
	const fromChecks = runIdsFromChecks(checks?.check_runs, { selfRunId: env.GITHUB_RUN_ID })
	// Unioned with the old head_sha query, which is still right for a run whose
	// head sha genuinely IS this commit — a pull_request-triggered one — and
	// whose check may not have been written yet. Wrong only for comment runs,
	// which is exactly the gap the checks above close.
	const list = gh(["api", `repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`])
	const fromRuns = chooseRunsToCancel(list?.workflow_runs, {
		selfRunId: env.GITHUB_RUN_ID,
		headSha: sha,
		workflowName: env.TC_ACTION_SELF_WORKFLOW,
	})
	const ids = [...new Set([...fromChecks, ...fromRuns.map(String)])]
	let cancelled = 0
	let forbidden = false
	for (const id of ids) {
		const r = ghRaw(["api", `repos/${REPO}/actions/runs/${id}/cancel`, "--method", "POST"])
		if (r.status === 0) cancelled++
		else if (/403|Resource not accessible/i.test(r.stderr ?? "")) forbidden = true
	}
	return { found: ids.length, cancelled, forbidden }
}

/**
 * A pull request closed without merging stops its run.
 *
 * Without the permission to cancel, the run finishes anyway and the comment
 * says it ran on a closed pull request — so this warns and lets it be,
 * rather than failing anything.
 */
function cancelForClosedPr(payload) {
	const sha = payload?.pull_request?.head?.sha
	if (!sha) return
	const { cancelled, forbidden } = cancelRunsOn(sha)
	if (cancelled > 0) {
		// Cancelling leaves the run's check in progress, and a check that never
		// resolves blocks anyone who made it required.
		// `stopRuns` used to complete it and went with `stop`; nothing replaced
		// it, so a pull request closed mid-run kept a pending check that came
		// back if it was reopened.
		const existing = inFlightCheckId(gh(["api", `repos/${REPO}/commits/${sha}/check-runs?per_page=100`])?.check_runs)
		if (existing) rememberCheck(sha, existing)
		postCheck(
			OUTCOMES.SKIPPED,
			{ outcome: "Skipped", summary: {}, runUrl: RUN_URL },
			sha,
			[],
			"completed",
			"The pull request was closed.",
		)
		notice(`Test Companion: stopped ${cancelled} run(s) — the pull request was closed without merging.`)
	} else if (forbidden) {
		warn("Could not stop the run for a closed pull request: this workflow needs `actions: write`.")
	}
}

/**
 * Which test framework the checked-out repository uses.
 *
 * Two levels deep and skipping node_modules and dotted directories: deep
 * enough for the common `e2e/playwright.config.ts` layout, shallow enough not
 * to walk a monorepo. Every read is best-effort — a repository we cannot scan
 * gets the generic starter, which is the honest outcome.
 */
function scanForFramework() {
	let deps = {}
	try {
		const pkg = JSON.parse(readFileSync("package.json", "utf8"))
		deps = { ...pkg.dependencies, ...pkg.devDependencies }
	} catch {
		// No package.json, or unreadable. A config file may still say.
	}

	const filenames = []
	const walk = (dir, depth) => {
		if (depth > 2) return
		let entries = []
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			if (e.name === "node_modules" || e.name.startsWith(".")) continue
			const full = dir === "." ? e.name : `${dir}/${e.name}`
			if (e.isDirectory()) walk(full, depth + 1)
			else filenames.push(full)
		}
	}
	walk(".", 0)
	return detectFramework({ filenames, deps })
}

/**
 * Open the pull request that adds the settings file.
 *
 * A pull request rather than a direct commit, deliberately: the settings decide
 * what Test Companion is allowed to do, so they go in the way every other
 * change to that does — reviewed.
 */
function openSetupPr(plan, configPath) {
	const framework = scanForFramework()
	const { branch, title, body } = renderSetupPr(configPath, framework)
	const base = settingsRef(readEvent(), env)
	const baseSha = gh(["api", `repos/${REPO}/git/ref/heads/${base}`])?.object?.sha
	if (!baseSha) {
		replyOnPr(plan.context.pr, `I could not read the ${base} branch, so I have not opened anything.`)
		return
	}

	// An existing branch from an earlier attempt is fine to reuse; the file write
	// below is what actually matters.
	ghRaw(["api", `repos/${REPO}/git/refs`, "--method", "POST", "--input", "-"], { ref: `refs/heads/${branch}`, sha: baseSha })

	const put = ghRaw(["api", `repos/${REPO}/contents/${configPath}`, "--method", "PUT", "--input", "-"], {
		message: title,
		content: Buffer.from(starterPipelineFor(framework), "utf8").toString("base64"),
		branch,
	})
	if (put.status !== 0) {
		replyOnPr(
			plan.context.pr,
			`I could not write \`${configPath}\` — this workflow may need \`contents: write\`. The run summary has the file to copy by hand.`,
		)
		return
	}

	const opened = gh(["api", `repos/${REPO}/pulls`, "--method", "POST", "--input", "-"], { title, head: branch, base, body })
	replyOnPr(
		plan.context.pr,
		opened?.html_url
			? `Opened ${opened.html_url} with the settings file. Nothing runs until it merges.`
			: `I pushed the settings to \`${branch}\` but could not open a pull request — this workflow may need \`pull-requests: write\`.`,
	)
}

/**
 * Drop proposals nobody answered.
 *
 * This is what makes the in-progress check safe to post at all. A proposal
 * never replied to would otherwise leave that check unresolved for the life
 * of the pull request, blocking anyone who made "Test Companion" required.
 *
 * Runs on the nightly schedule, alongside whatever else is bound to it.
 */
function sweepExpiredProposals() {
	const prs = flattenPages(gh(["api", `repos/${REPO}/pulls?state=open&per_page=100`, "--paginate", "--slurp"]))
	for (const pr of prs) {
		const sha = pr?.head?.sha
		if (!sha || !pr?.number) continue
		const comments = flattenPages(gh(["api", `repos/${REPO}/issues/${pr.number}/comments`, "--paginate", "--slurp"]))
		if (!proposalNeedsDropping(comments, sha, Date.now(), botLogin)) continue
		// The same question, asked again for the ANSWER rather than the yes/no:
		// the dropped marker has to name the job, or dropping one stale plan
		// would finish off every other plan on that commit.
		const stale = findProposal(comments, sha, Date.now(), botLogin)
		// A proposal written before the job was recorded has no workflow, and a
		// marker with no workflow means the WHOLE COMMIT under the legacy rule
		// in SPENT_MARKER — so sweeping one old plan would kill every current
		// one beside it, which is the thing per-job plans set out to stop. Leave it;
		// it is already expired, so it cannot be approved either way.
		if (!stale?.workflow) {
			notice(`Test Companion: left an untagged stale proposal on #${pr.number} rather than sweeping the whole commit.`)
			continue
		}

		// Complete the check the PROPOSAL run left in progress, rather than
		// adding a second one beside it. The sweep is a different process with
		// an empty memo, so without this lookup the proposal's check stayed
		// pending for the life of the branch — the "blocked by a check that
		// never arrives" failure this sweep exists to prevent.
		const existing = inFlightCheckId(gh(["api", `repos/${REPO}/commits/${sha}/check-runs?per_page=100`])?.check_runs)
		if (existing) rememberCheck(sha, existing)

		// "Action required", by design — checkConclusion already maps Could not run
		// to exactly that, and never to neutral, which branch protection reads as a pass.
		postCheck(OUTCOMES.COULD_NOT_RUN, { outcome: OUTCOMES.COULD_NOT_RUN, summary: {}, runUrl: RUN_URL }, sha)
		replyOnPr(
			pr.number,
			`That proposal went unanswered, so I have dropped it. The check now says Action required — comment again and I will put up a fresh one.\n\n${proposalDroppedMarkerFor(sha, stale?.workflow)}`,
		)
		notice(`Test Companion: dropped a stale proposal on #${pr.number}.`)
	}
}

/**
 * What the pipeline file binds to this event, with every value resolved.
 *
 * Asks the CLI rather than parsing the YAML here: one parser, one schema, one
 * place for it to drift. Returns undefined when the read fails, which
 * decideGate treats as "hold for review" — failing closed.
 */
function readBindings(configFile, event, branch) {
	// `--branch` narrows the same way a run does. Without it this returns
	// bindings a `when:` clause would exclude, and pickBinding could hand
	// decideGate the approval policy of a binding that never runs — reading
	// `straight-through` off one while the CLI ran another, which skipped the
	// gate in the direction that writes.
	const base = ["workflow", "bindings", "--config", configFile, "--event", event]
	const ask = (extra) =>
		spawnSync("tc", [...base, ...extra, "--json"], {
			encoding: "utf8",
			env: childEnvFor(env),
		})

	let r = branch ? ask(["--branch", branch]) : ask([])
	// An older CLI does not know --branch. Falling back is much better than
	// losing the settings block entirely: without it there is no wcag, no
	// targets, no tests_repo and no ask_team, and the run quietly behaves as
	// though the repository had configured none of them. The cost of the
	// fallback is only that bindings are not branch-narrowed, which is exactly
	// how it behaved before the flag existed.
	if (branch && r.status !== 0 && /unknown flag|unknown shorthand/i.test(r.stderr ?? "")) {
		warn("This CLI does not support `workflow bindings --branch`; reading bindings without branch narrowing.")
		r = ask([])
	}
	if (r.status !== 0) {
		warn(`Could not read the pipeline bindings: ${(r.stderr ?? "").trim().split("\n").pop()}`)
		return undefined
	}
	try {
		return JSON.parse(r.stdout)
	} catch {
		return undefined
	}
}

/** The binding a comment is asking for, or the one bound to the event. */
function pickBinding(doc, workflow) {
	const list = (doc?.bindings ?? []).filter((b) => b.enabled)
	return workflow ? list.find((b) => b.workflow === workflow) : list[0]
}

/**
 * A plain reply in the thread.
 *
 * Deliberately NOT the tracked run comment: it carries no COMMENT_MARKER, so a
 * later run neither overwrites a refusal nor adopts one as the place it reports.
 */
function replyOnPr(pr, body) {
	if (!pr) return
	gh(["api", `repos/${REPO}/issues/${pr}/comments`, "--method", "POST", "--input", "-"], { body })
}

/**
 * Mark the approved plan spent, ON THE PROPOSAL ITSELF.
 *
 * Put in the shared result comment it would not survive: every later run
 * REPLACES that body, so the record of an approval disappears, `findProposal`
 * offers the plan as waiting again, and a bare `go` re-runs a `--yolo` job.
 * A proposal comment is written once and never rewritten, so the marker
 * lasts there.
 *
 * Best effort: failing to mark it must not take down a run that has already
 * done its work.
 */
function markPlanSpent(planId, marker) {
	if (!planId || !marker) return
	const current = gh(["api", `repos/${REPO}/issues/comments/${planId}`])
	const body = String(current?.body ?? "")
	if (!body || body.includes(marker)) return
	gh(["api", `repos/${REPO}/issues/comments/${planId}`, "--method", "PATCH", "--input", "-"], { body: `${body}\n\n${marker}` })
}

function postComment(pr, view) {
	// `--slurp` matters: without it `gh --paginate` prints ONE JSON ARRAY PER
	// PAGE, so the output of a pull request with more than 30 comments is
	// `[...][...]`, JSON.parse throws, gh returns null and `existing` becomes
	// []. Every run then posted a NEW comment instead of editing its own, which
	// broke the single-comment guarantee.
	const existing = flattenPages(gh(["api", `repos/${REPO}/issues/${pr}/comments`, "--paginate", "--slurp"]))
	const choice = chooseCommentAction(existing, botLogin)
	// An approved proposal must stop looking like one.
	// Without this a second `go` reran the job, and a day later the sweep told
	// the person their approved plan had gone unanswered.
	const body = { body: renderComment(view) + (view.consumedMarker ? `\n${view.consumedMarker}` : "") }
	if (choice.action === "update") {
		gh(["api", `repos/${REPO}/issues/comments/${choice.id}`, "--method", "PATCH", "--input", "-"], body)
	} else {
		gh(["api", `repos/${REPO}/issues/${pr}/comments`, "--method", "POST", "--input", "-"], body)
	}
}

// A crash after the job finishes would leave no tick and no comment, which
// is worse than a red tick: anyone who made the check required is blocked by
// a check that never arrives, with nothing on the pull request saying why.
//
// finishSkipped and the normal path both exit(0) from inside main, so
// reaching this catch means something unexpected threw. Report it as "Could
// not run" and still exit 0, so the build-effect step decides whether the
// build goes red.
try {
	await main()
} catch (e) {
	const message = e?.stack || String(e)
	const fence = "```"
	notice(`Test Companion could not complete: ${message}`)
	addToJobSummary(
		`## Test Companion \u2014 ${OUTCOMES.COULD_NOT_RUN}\n\nThe action itself failed before it could report.\n\n${fence}\n${message}\n${fence}`,
	)
	setOutput("outcome", OUTCOMES.COULD_NOT_RUN)
	setOutput("should-fail", String(stepShouldFail(env.TC_ACTION_BUILD_EFFECT, OUTCOMES.COULD_NOT_RUN)))
	try {
		// The commit we already posted the in-progress check on, NOT the
		// event's sha: on a comment run GITHUB_SHA is the default branch's
		// commit, so this used to post a second check on main and leave the
		// pull request's one pending.
		postCheck(
			OUTCOMES.COULD_NOT_RUN,
			{ outcome: OUTCOMES.COULD_NOT_RUN, summary: {}, runUrl: RUN_URL },
			checkSubjectFor(checksMade, env.GITHUB_SHA),
		)
	} catch {
		// Nothing left to try. The job summary above is still written.
	}
	process.exit(0)
}
