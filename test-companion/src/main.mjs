/** The Action's entry point: I/O only. Decisions live in the pure modules beside it. */
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
import { runCapturingAnswer, redactSecrets, secretsFrom } from "./answer.mjs"
import {
	appCredentials,
	signJwt,
	installationTokenRequest,
	appApi,
	installationLookupMessage,
} from "./app-auth.mjs"
import { OUTCOMES, parseSummary, resolveOutcome, checkConclusion, stepShouldFail, approvalWasSpent, runDidNotWork } from "./outcome.mjs"
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
	splitHandoffPaths,
	savingFor,
	leaveOut,
	leaveOutMessage,
	listFiles,
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
	commitIdentity,
	handedOffPrRequest,
} from "./push-work.mjs"

const env = process.env
const REPO = env.GITHUB_REPOSITORY ?? ""
const RUN_URL = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${REPO}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`
// RUNNER_TEMP is cleared per job; /tmp may hold an earlier job's files on a reused runner.
const REPORT_DIR = env.RUNNER_TEMP || tmpdir()
const SUMMARY_FILE = join(REPORT_DIR, "test-companion-report.md")
// What the run produced. For a preview run this is the only copy of the generated cases.
const RESULT_FILE = join(REPORT_DIR, "test-companion-result.md")

// Must match the upload step in action.yml.
const RESULT_ARTIFACT = "test-companion-result"

const setOutput = (k, v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`)
const addToJobSummary = (md) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, md + "\n")
const notice = (m) => console.log(`::notice::${m}`)
const warn = (m) => console.log(`::warning::${m}`)

// Resolved at load, before the agent runs, so a gh it plants on PATH is never used.
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

// Every gh call goes through here (a test checks). Each call gets a fresh config dir and its own token.
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

function ghRaw(args, body) {
	return runGh(args, { token: env.GH_TOKEN, input: body ? JSON.stringify(body) : undefined })
}

/** `gh api`, returning parsed JSON or null. Never throws. */
function gh(args, body) {
	const r = ghRaw(args, body)
	if (r.status !== 0) {
		// A missing permission skips that write; it never fails the run.
		warn(`GitHub API call failed (${args[1] ?? args[0]}): ${(r.stderr ?? "").trim().split("\n")[0]}`)
		return null
	}
	try {
		return JSON.parse(r.stdout)
	} catch {
		return null
	}
}

// Who the Action's commits are by; the App's bot account once we act as it.
let identity = commitIdentity()

// The login our comments appear under: github-actions[bot], or <app-slug>[bot] with the App.
// Used to tell our proposals from another bot's.
let botLogin = "github-actions[bot]"

/** HEAD before the agent ran, so a commit it made can be told from ours. */
let headBeforeRun = ""

/** Set when this run is carrying out an approved proposal, so the plan is marked spent. */
let consumedMarker = ""

/** What happened to a pull request the CLI handed back to open, for the comment. */
let handoffNote

// The CLI this job installed, in the runner's home, out of the agent's reach.
const TC_PATH = join(env.HOME ?? "", ".local", "bin", "tc")

// Off by default: unisolated, the agent can reach every token and secret in the job.
const ALLOW_UNISOLATED = /^true$/i.test(String(env.TC_ACTION_ALLOW_UNISOLATED ?? "").trim())

/** The proposal this run is carrying out, so the report can link it. */
let approvedPlan

// No --depth: it would make the full clone shallow. The URL carries its own credential
// because the starter sets persist-credentials: false.
function fetchAndCheckout(sha, branch) {
	const url = pushUrlFor(REPO, env.GITHUB_SERVER_URL)
	if (!url || !sha) return false
	const cred = pushCredentialEnv(env.GH_TOKEN, url)
	if (!git(["fetch", url, sha], cred).ok) return false
	return branch ? git(["checkout", "-B", branch, sha]).ok : git(["checkout", "--detach", sha]).ok
}

/** A repo-scoped App installation token, or undefined to fall back to the workflow token. */
async function appInstallationToken() {
	const creds = appCredentials(env)
	if (!creds) return undefined
	// Remove the key from the environment so nothing started later, the agent included, inherits it.
	delete env.TC_ACTION_APP_PRIVATE_KEY

	let jwt
	try {
		jwt = signJwt(creds)
	} catch (e) {
		warn(`Could not sign the GitHub App token (${e?.message ?? e}); using the workflow token instead.`)
		return undefined
	}

	// The JWT authenticates the App; only the installation token can touch a repository.
	const asApp = (path, opts) => appApi(path, { jwt, apiUrl: env.GITHUB_API_URL, ...opts })

	const found = await asApp(`repos/${REPO}/installation`)
	if (!found.ok) {
		const { level, text } = installationLookupMessage(found)
		if (level === "warning") warn(text)
		else notice(text)
		return undefined
	}
	const installationId = found.data?.id
	// Adopted only once a token is minted, so a failed mint can't leave us looking under the wrong login.
	const appLogin = found.data?.app_slug ? `${found.data.app_slug}[bot]` : undefined
	if (!installationId) {
		warn("Test Companion: GitHub's reply about the App's installation had no ID; using the workflow token.")
		return undefined
	}

	// Scoped to this repository; an empty request gets every repository the installation covers.
	const scope = installationTokenRequest(REPO)
	if (!scope) {
		warn(`Could not read "${REPO}" as owner/name, so no scoped App token was requested.`)
		return undefined
	}

	// No retry with a smaller request: dropping the permission list asks for everything the installation holds.
	const minted = await asApp(`app/installations/${installationId}/access_tokens`, { method: "POST", body: scope })
	if (!minted.ok) {
		warn(
			`Test Companion: could not get a GitHub App token with the permissions it needs (${minted.reason}); using the workflow token instead. ` +
				"If the App's permissions were changed, an organisation owner may need to accept them.",
		)
		return undefined
	}

	const token = minted.data?.token
	if (!token) {
		warn("Test Companion: GitHub's reply had no App token; using the workflow token.")
		return undefined
	}

	// Mask before first use.
	console.log(`::add-mask::${token}`)
	if (appLogin) {
		botLogin = appLogin
		// The bot account's id makes the noreply email GitHub links to the App.
		const user = runGh(["api", `users/${encodeURIComponent(appLogin)}`, "--jq", ".id"], { token })
		if (user.status !== 0) warn(`Test Companion: could not look up ${appLogin}'s account, so commits use the plain Test Companion name.`)
		identity = commitIdentity({ appSlug: found.data?.app_slug, appUserId: user.status === 0 ? String(user.stdout ?? "").trim() : "" })
	}
	return token
}

/**
 * The settings file from the default branch, so a pull request cannot rewrite the rules for its own run.
 * Returns the local path, or undefined (treated as no settings).
 */
function fetchSettings(path, ref) {
	const r = runGh(
		["api", `repos/${REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`, "-H", "Accept: application/vnd.github.raw"],
		{ token: env.GH_TOKEN },
	)
	if (r.status !== 0) {
		const first = (r.stderr ?? "").trim().split("\n")[0]
		// 404 just means no settings file yet.
		if (!/404|Not Found/i.test(first)) warn(`Could not read ${path} from ${ref}: ${first}`)
		return undefined
	}
	const local = join(REPORT_DIR, "testcompanion-pipeline.default-branch.yml")
	writeFileSync(local, r.stdout)
	return local
}

/** admin, maintain and write may ask for a run. Any failure counts as no. */
function hasWriteAccess(login) {
	if (!login) return false
	const res = gh(["api", `repos/${REPO}/collaborators/${login}/permission`])
	return ["admin", "maintain", "write"].includes(res?.permission)
}

/** Undefined when we cannot find out; mayAsk treats that as no. */
function isOnTeam(login, team) {
	if (!login || !team) return undefined
	const org = REPO.split("/")[0]
	const res = gh(["api", `orgs/${org}/teams/${team}/memberships/${login}`])
	if (!res) return undefined
	return res.state === "active"
}

// Resolved at load, before the agent runs. Absent means we do not commit.
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

function git(args, extraEnv = {}, input = undefined) {
	// Near-empty environment and no hooks: the agent has had write access to the tree.
	if (!GIT_BIN) return { ok: false, out: "", raw: "", err: "no trusted git binary" }
	const r = spawnSync(GIT_BIN, [...GIT_SAFE_ARGS, ...args], {
		encoding: "utf8",
		input,
		env: { ...gitEnvFrom(env), ...extraEnv },
	})
	// `raw` keeps porcelain's leading space; trimming would lose the first line's status column.
	return { ok: r.status === 0, out: (r.stdout ?? "").trim(), raw: r.stdout ?? "", err: (r.stderr ?? "").trim() }
}

/** The repository's default branch, or undefined. */
function defaultBranchName() {
	return gh(["api", `repos/${REPO}`])?.default_branch
}

let cachedEvent
function readEvent() {
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
	// Complete any in-progress check we posted, so it isn't left pending.
	for (const sha of checksMade.keys()) {
		postCheck(OUTCOMES.SKIPPED, { outcome: "Skipped", summary: {}, runUrl: RUN_URL }, sha, [], "completed", msg)
	}
	addToJobSummary(`## Test Companion\n\n${msg}${detail ? `\n\n\`${detail}\`` : ""}`)
	setOutput("outcome", "Skipped")
	setOutput("should-fail", "false")
	process.exit(0)
}

/** No settings file: pass and show a starter. */
function finishWithStarter(path) {
	notice(`Test Companion: no ${path} yet, so there is nothing to run. A starter is on the run summary.`)
	addToJobSummary(renderNoPipelineReport(path))
	setOutput("outcome", "Skipped")
	setOutput("should-fail", "false")
	process.exit(0)
}

async function main() {
	// Without a trusted gh nothing can be reported.
	if (!GH_BIN) {
		console.log(
			"::error::Test Companion could not find GitHub's gh command in a system folder this job cannot write to " +
				"(/usr/bin, /usr/local/bin, /opt/homebrew/bin or /bin). It will not run a gh found elsewhere, because " +
				"that copy could have been replaced. Install gh system-wide on this runner.",
		)
		process.exit(1)
	}

	// Act as the App when installed, before anything else talks to GitHub.
	const appToken = await appInstallationToken()
	if (appToken) {
		env.GH_TOKEN = appToken
		notice("Test Companion: acting as the GitHub App.")
	}

	// No credentials is the normal case for a fork pull request: skip, don't fail.
	if (!env.BROWSERSTACK_USERNAME || !env.BROWSERSTACK_ACCESS_KEY) {
		finishSkipped("no-credentials")
	}

	const configPath = pipelineConfigPath(env.TC_ACTION_CONFIG, env)
	// From the default branch, never the branch under test. May be absent; the setup request
	// below still has to work then.
	const settingsFile = fetchSettings(configPath, settingsRef(readEvent(), env))

	// Clear expired proposals first so none leaves a check stuck in progress.
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
		// Closing a pull request without merging stops what it started.
		if (plan.skip.reason === "closed-unmerged") cancelForClosedPr(readEvent())
		finishSkipped(plan.skip.reason, plan.skip.detail)
	}

	// Comment triggers need write access. Keyed on the trigger, so a planner change can't drop
	// the check. Fails closed. A comment names an issue, so resolve the pull request's head.
	let pull
	if (!plan.context?.sha && plan.context?.pr) {
		pull = gh(["api", `repos/${REPO}/pulls/${plan.context.pr}`])
		plan = withPullRequestHead(plan, pull, REPO)
		if (plan.skip) finishSkipped(plan.skip, `PR #${plan.context.pr}`)
		// The starter checks out the default branch for a comment event.
		if (!fetchAndCheckout(plan.context.sha)) {
			warn(`Could not check out ${plan.context.sha}; running against the tree this job checked out.`)
		}
	}

	// The ticket this change is for, so the run tests what it asks for.
	const prForTicket = pull ?? readEvent().pull_request
	const ticket = findTicket({
		title: prForTicket?.title,
		branch: plan.context?.branch ?? prForTicket?.head?.ref,
		body: prForTicket?.body,
	})
	if (ticket && plan.context) plan.context.ticket = ticket

	// Read before the access check: ask_team lives in the same file.
	const bindingsDoc = settingsFile && plan.event ? readBindings(settingsFile, plan.event, plan.context?.branch) : undefined
	const askTeam = bindingsDoc?.settings?.ask_team

	// Jobs that understand --propose-only and --plan-file.
	const CARRIES_A_PLAN = new Set(["test-pr"])
	// Jobs that cannot run without knowing which build failed.
	const NEEDS_A_BUILD = new Set(["rca", "fix", "verdict"])
	const COMMENT_TRIGGERS = new Set(["issue_comment"])
	if (COMMENT_TRIGGERS.has(env.GITHUB_EVENT_NAME) || plan.requiresWriteAccess) {
		const who = plan.commenter ?? readEvent().comment?.user?.login
		// Write access is the floor; ask_team may narrow it, never widen it.
		const allowed = mayAsk({
			hasWriteAccess: hasWriteAccess(who),
			askTeam,
			inTeam: askTeam ? isOnTeam(who, askTeam) : undefined,
		})
		if (!allowed) {
			// Don't reply to a bystander's bare "go".
			if (!plan.approvalOnly) replyOnPr(plan.context?.pr, renderNotAuthorized(who ?? "there", askTeam))
			finishSkipped("not-authorized", who)
		}
	}

	// Place the request before spawning the CLI, so one we can't place costs nothing.
	let proposing = false
	let approvalNote = ""
	if (plan.event === TC_EVENTS.PR_COMMENT) {
		// Fetched before reading intent: with a plan waiting, "go, and fix case 3" is an approval with an edit.
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
		// `stop` is retired but still answered, ahead of job words, so it never starts a run.
		if (intent.kind === INTENT.STOP) {
			replyOnPr(plan.context.pr, renderStopRemoved())
			finishSkipped("stopped")
		}
		if (intent.kind === INTENT.SETUP) {
			openSetupPr(plan, configPath)
			finishSkipped("setup-requested")
		}

		// `go #<id>` names which plan.
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

		// A named job narrows the binding; the binding still governs mode and limits.
		if (intent.workflow) plan.workflow = intent.workflow

		const bindings = bindingsDoc
		const binding = pickBinding(bindings, intent.workflow)

		// A comment may only ask for a bound workflow.
		if (intent.workflow && bindings && !binding) {
			replyOnPr(
				plan.context.pr,
				`\`${intent.workflow}\` is not bound to pull request comments in this repository, so nothing ran. Bind it in \`${configPath}\` under \`on: pr_comment\`.`,
			)
			finishSkipped("not-bound", intent.workflow)
		}

		// An unaddressed comment only reaches here as a possible approval.
		if (plan.approvalOnly && !waiting) {
			// Checked before the superseded case, which would otherwise match an older plan.
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
			// The job that will actually run.
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
			// Proposals expire after 24 hours.
			replyOnPr(
				plan.context.pr,
				"That proposal is more than a day old, so I have dropped it. Ask again and I will put up a fresh one.",
			)
			finishSkipped("proposal-expired")
		}

		if (gate.approvedProposal) {
			// Run the job that was proposed, not whatever the event would pick.
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

			// Adopt the proposal run's in-progress check instead of posting a second one.
			const pending = inFlightCheckId(
				gh(["api", `repos/${REPO}/commits/${plan.context.sha}/check-runs?per_page=100`])?.check_runs,
			)
			if (pending) rememberCheck(plan.context.sha, pending)
			// Per job, so approving one doesn't spend another job's plan.
			consumedMarker = proposalConsumedMarkerFor(plan.context.sha, plan.workflow)
			approvedPlan = waiting?.url ? { id: waiting.id, url: waiting.url } : undefined

			// The approved plan, edits included, goes in a file: --context strips punctuation.
			const replyText = plan.context.instructions
			const planFile = join(REPORT_DIR, "approved-plan.md")
			writeFileSync(planFile, renderApprovedPlan(waiting?.body, replyText))
			if (CARRIES_A_PLAN.has(plan.workflow)) plan.context.plan_file = planFile

			// The raw reply stops here; its edits are already in the plan file.
			delete plan.context.instructions

			// Self-approval is reported, not refused: nobody else reviewed the plan or its edits.
			if (gate.selfApproved) {
				approvalNote = hasApproverEdits(replyText)
					? ` Approved by @${plan.commenter}, who also asked for it — and edited the plan while approving, so nobody else reviewed those changes.`
					: ` Approved by @${plan.commenter}, who also asked for it.`
				notice(`Test Companion:${approvalNote}`)
			}
		} else {
			// A large change: the run covers what matters and lists what it skipped.
			const size = describeChangeSize(pull)
			if (size.large) {
				plan.context.focus = `${size.files} files and ${size.lines} changed lines`
			}
		}

		proposing = gate.action === GATE.PROPOSE
		// Only test-pr has --propose-only; other jobs propose through a preview run.
		if (proposing && CARRIES_A_PLAN.has(plan.workflow)) plan.context.propose_only = "true"
		if (gate.preview || intent.preview) plan.preview = true

		// Last, because the job isn't final until approval is handled ("go" names none).
		// rca, fix and verdict need a failed build: default to the newest red run on this commit.
		if (NEEDS_A_BUILD.has(plan.workflow) && !plan.context.build) {
			const runs = gh(["api", `repos/${REPO}/actions/runs?head_sha=${plan.context.sha}&per_page=100`])
			const failed = latestFailedRun(runs?.workflow_runs, {
				selfRunId: env.GITHUB_RUN_ID,
				selfWorkflowName: env.TC_ACTION_SELF_WORKFLOW,
			})
			if (!failed) {
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

	// After comment handling, which costs only API calls and must reach the setup request.
	if (!settingsFile) {
		finishWithStarter(configPath)
	}


	// Comment events check out the default branch and pull_request events the merge commit, so
	// move to the commit under review. Advisory: shouldPushWork re-checks before pushing.
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
		// A comment event fetched `pull`; a pull_request event carries the head on its payload.
		sameRepo: isSameRepo(prForTicket?.head?.repo?.full_name, REPO),
		branch: plan.context.branch,
		headAuthorEmail: git(["log", "-1", "--format=%ae"]).out,
		ourEmails: [identity.email],
		// The earlier checkout is advisory, so confirm we are on the reviewed commit before pushing.
		onWantedCommit: !needsCheckout({ headSha: git(["rev-parse", "HEAD"]).out, wantSha: plan.context.sha }),
		defaultBranch: defaultBranchName(),
		workflow: plan.workflow,
	})
	if (plan.context.branch && !plan.preview && !saving.ok && !saving.quiet) {
		notice(`Nothing will be saved to ${plan.context.branch}: ${saving.why}.`)
	}

	// Lock the agent down (see sandbox-policy.mjs). After the checkout, so it gets the reviewed tree.
	const sandbox = isolateAgent(plan)

	// A manual run names its job; an event run passes only --event and the pipeline file chooses.
	const args = ["workflow", "run"]
	if (plan.workflow) args.push(plan.workflow)
	if (plan.event) args.push("--event", plan.event)
	// Locked down, the agent reads copies in its `in` folder and writes to its `out` folder.
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

	// The agent can't write to GitHub, so the Action plants the "already running" marker itself.
	const claim = sandbox ? holdClaim(plan, settingsFile) : { held: false }
	if (claim.collision) finishSkipped("already-done", claim.workflow)
	if (claim.passFlag) args.push("--claim-held")

	// Posted before the run so a closed pull request can find and cancel it.
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
	// Remove stale files so a run that produces nothing can't report an earlier run's work.
	for (const f of [SUMMARY_FILE, RESULT_FILE]) {
		try {
			rmSync(f, { force: true })
		} catch {
			// Not worth failing over.
		}
	}
	// The agent never gets the GitHub token.
	const run = sandbox ? await runLockedDown(sandbox, args, runFiles) : await runCapturingAnswer("tc", args, childEnvFor(env))
	const exitCode = run.status ?? 1

	if (sandbox) {
		// Stop the agent's processes before reading its files or saving its work.
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

	// Absent if the process was killed.
	let summaryText
	try {
		summaryText = readFileSync(SUMMARY_FILE, "utf8")
	} catch {
		summaryText = undefined
	}
	const summary = parseSummary(summaryText)
	// Read separately: parseSummary would collapse repeated failed_test keys.
	const failedTests = parseFailedTests(summaryText)
	const outcome = resolveOutcome(exitCode, summary)

	// Nothing bound to this event: finish like any other skip.
	if (outcome === OUTCOMES.SKIPPED) {
		finishSkipped("no-binding", summary.event)
	}
	const hasResult = existsSync(RESULT_FILE)
	const readResult = () => {
		try {
			return readFileSync(RESULT_FILE, "utf8")
		} catch {
			// Best effort.
			return undefined
		}
	}

	// A configured write that can't happen is reported.
	const warnings = []
	const testsRepo = bindingsDoc?.settings?.tests_repo
	if (testsRepo) {
		const probe = gh(["api", `repos/${testsRepo}`])
		const access = describeTestRepoAccess({ testsRepo, thisRepo: REPO, canPush: probe?.permissions?.push })
		if (!access.ok) warnings.push(access.message)
	}

	const extraChecks = renderExtraChecks(summary, {
		wcag: bindingsDoc?.settings?.wcag,
		visual: bindingsDoc?.settings?.visual,
	})

	// automate and fix hand back a pull request; other jobs save to this branch.
	// Re-checked with the job the pipeline chose: an event run didn't know it before the run.
	const workNote = handoffNote ?? saveWork(savingFor(saving, plan.workflow ?? summary.workflow), plan)

	const view = {
		workflow: plan.workflow ?? summary.workflow,
		approvedPlan,
		workNote,
		extraChecks,
		warnings,
		outcome,
		summary,
		runUrl: RUN_URL,
		// Shown so runs on the same pinned version are comparable.
		cliVersion: summary.cli_version || env.TC_ACTION_CLI_VERSION,
		resultArtifact: hasResult ? RESULT_ARTIFACT : undefined,
		// Whose request this answers; the comment is edited in place.
		askedBy: plan.commenter,
		askedAt: plan.askedAt,
		// rca and verdict leave no artefact: the answer is the agent's closing words. The result
		// file is the fallback, only for ANSWER_JOBS (for generate it holds test cases).
		answer: redactSecrets(
			run.answer || (hasResult && ANSWER_JOBS.has(plan.workflow ?? summary.workflow) ? readResult() : undefined),
			secretsFrom(env),
		),
		failedTests,
		// Only where the run didn't work, so a stray error line never colours a success.
		errorLine: runDidNotWork(outcome) ? redactSecrets(run.error, secretsFrom(env)) : undefined,
	}
	// Proposing: post what it would do and stop. A run that broke has nothing to approve,
	// so it is reported like any other run, which also completes its check.
	if (proposing && !runDidNotWork(outcome)) {
		const sha = checkSha(plan.context, summary, env.GITHUB_SHA)
		addToJobSummary(renderJobSummary(view))
		const size = describeChangeSize(pull)
		const sizeNote = size.large
			? `> **This is a large change** — ${size.files} files and ${size.lines} changed lines. Trim the list below before replying go if you only want part of it covered.\n\n`
			: ""
		// The plan itself, from the result file.
		let planBody = ""
		try {
			planBody = readFileSync(RESULT_FILE, "utf8")
		} catch {
			// No plan; renderProposalBody says so.
		}
		replyOnPr(
			plan.context.pr,
			renderProposal(
				// Capped: an over-long comment fails to post.
				renderProposalBody({ summary: renderCheckSummary(view), plan: planBody, sizeNote }),
				sha,
				plan.commenter,
				// Record the job, so approving can't run a different one.
				plan.workflow ?? summary.workflow,
			),
		)
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

	// Annotate each failing test on its line, when the reporter gave one.
	const annotations = buildAnnotations(failedTests)
	// Accessibility can turn the check red only when configured, and only for new violations.
	const checkOutcome =
		outcome === OUTCOMES.SUCCEEDED &&
		accessibilityFailsCheck(summary, {
			wcag: bindingsDoc?.settings?.wcag,
			failOnNew: bindingsDoc?.settings?.fail_on_new,
		})
			? OUTCOMES.TESTS_FAILED
			: outcome
	postCheck(checkOutcome, view, checkSha(plan.context, summary, env.GITHUB_SHA), annotations)
	// Spend the plan only if a run happened. Marked on the proposal, which later runs don't rewrite.
	if (approvalWasSpent(outcome)) markPlanSpent(approvedPlan?.id, consumedMarker)
	if (plan.context.pr)
		postComment(plan.context.pr, {
			...view,
			approvalNote,
			consumedMarker: approvalWasSpent(outcome) ? consumedMarker : "",
		})

	// Always exit 0; a separate step applies the build effect.
	process.exit(0)
}

/**
 * Commit what the run wrote onto the pull request's branch.
 * Returns the line for the comment. Never throws.
 */
function saveWork(saving, plan) {
	if (!saving.ok) return undefined
	const branch = plan.context.branch
	// We push HEAD, so refuse if the agent committed: its commit would ride along unfiltered.
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

	// The agent could have edited .git/config (hooks, filters, URL rewrites). Checked before
	// `git status`, which can itself run a clean filter.
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
	// quotePath=false keeps non-ASCII paths as-is; -uall lists new directories file by file.
	const status = git(["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"])
	if (!status.ok) return undefined
	const { push, skip } = splitPushable(changedPaths(status.raw), {
		isSymlink: (p) => {
			try {
				return lstatSync(p).isSymbolicLink()
			} catch {
				// Gone or unreadable: not a link.
				return false
			}
		},
	})
	if (push.length === 0) return undefined

	// Named paths only, never `git add -A`.
	const added = git(["add", "--", ...push])
	if (!added.ok) return renderPushNote({ branch, files: push, skipped: skip, error: added.err || "git add failed" })

	const subject = `test: ${plan.workflow ?? "Test Companion"} on ${String(plan.context.sha ?? "").slice(0, 7)}`
	const body = [
		subject,
		"",
		`Written by Test Companion for ${plan.context.pr ? `#${plan.context.pr}` : plan.context.sha}.`,
		`Run: ${RUN_URL}`,
	].join("\n")
	const committed = git(["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "-m", body])
	if (!committed.ok) {
		return renderPushNote({
			branch,
			files: push,
			skipped: skip,
			error: committed.err || committed.out || "nothing to commit",
		})
	}

	// Push to a URL built from GITHUB_REPOSITORY, not `origin`: an insteadOf rewrite in
	// .git/config could send the token elsewhere.
	const target = pushUrlFor(REPO, env.GITHUB_SERVER_URL)
	if (!target)
		return renderPushNote({ branch, files: push, skipped: skip, error: `cannot push: bad repository name "${REPO}"` })
	const pushed = git(["push", target, `HEAD:refs/heads/${branch}`], pushCredentialEnv(env.GH_TOKEN, target))
	if (!pushed.ok) {
		// The workflow token is read-only by default.
		const hint = /403|permission|denied|protected/i.test(pushed.err)
			? `${pushed.err} — the job needs \`permissions: contents: write\`, and the branch must not be protected against it.`
			: pushed.err || "git push failed"
		return renderPushNote({ branch, files: push, skipped: skip, error: hint })
	}
	return renderPushNote({ branch, sha: git(["rev-parse", "HEAD"]).out, files: push, skipped: skip })
}

/** Set up the locked-down user. Without it, stop unless allow-unisolated is set. */
function isolateAgent(plan) {
	const can = canIsolate()
	let why = can.why
	if (can.ok) {
		try {
			const layout = prepareSandbox({ repoDir: process.cwd(), tcPath: TC_PATH, identity })
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

/** What the installed CLI supports, asked once. */
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
		// An unknown subcommand prints the parent's help and exits 0.
		claimCommand: /--release/.test(`${claim.stdout ?? ""}${claim.stderr ?? ""}`),
	}
	return cliAbilities
}

/**
 * Plant the "already running" marker before the agent starts.
 * Returns { collision, workflow } if the job already ran, else { held, passFlag }.
 */
function holdClaim(plan, settingsFile) {
	const can = cliSupports()
	if (!can.claimHeld || !can.claimCommand) {
		warn(
			"This version of the Test Companion CLI cannot hand its GitHub writes to the Action, so a live generate, automate or fix run may not be able to save its work. Update the CLI.",
		)
		return { held: false, passFlag: false }
	}
	// Preview writes nothing, the marker included.
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

/** The node the launcher runs with; copied in when ours is under the runner's home. */
function nodeForAgent(sandbox) {
	const home = String(env.HOME ?? "")
	if (!home || !process.execPath.startsWith(`${home}/`)) return process.execPath
	return handToAgent(sandbox, process.execPath, "node")
}

/** Run the CLI as the locked-down user, with the read-only relay up. */
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
		// Best effort; the CLI also reads credentials from its environment.
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
 * Open the pull request automate or fix handed back, with the same refusals as saveWork.
 * Returns the line for the comment, or undefined.
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
	// --raw gives file modes, so a symlink is caught from the commit itself.
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
	const { refused, dropped } = splitHandoffPaths(paths, { isSymlink: (p) => links.has(p) })
	if (refused.length) {
		return `**Did not open a pull request:** the branch changes files Test Companion never pushes: ${listFiles(refused)}.`
	}
	let head = tip.out
	if (dropped.length) {
		const indexFile = join(REPORT_DIR, `tc-handoff-index-${process.pid}`)
		let left
		try {
			left = leaveOut({ git, base: from.out, tip: tip.out, paths: dropped, identity, message: leaveOutMessage(req.title, dropped), indexFile })
		} finally {
			rmSync(indexFile, { force: true })
		}
		if (left.error) return `**Could not open the pull request:** ${left.error}.`
		if (left.empty) {
			return `**Did not open a pull request:** the run's only changes were files Test Companion never commits: ${listFiles(dropped)}.`
		}
		head = left.sha
	}
	const leftOutNote = dropped.length ? ` Left out ${listFiles(dropped)}, which Test Companion never commits.` : ""
	const target = pushUrlFor(REPO, env.GITHUB_SERVER_URL)
	if (!target) return `**Could not open the pull request:** bad repository name "${REPO}".`
	const onReviewedCommit = String(headBeforeRun ?? "").toLowerCase() === String(plan.context.sha ?? "").toLowerCase()
	const request = handedOffPrRequest({
		req,
		pr: plan.context.pr,
		prBranch: plan.context.branch,
		defaultBranch: defaultBranchName(),
		onReviewedCommit,
	})
	const baseNote =
		plan.context.pr && !onReviewedCommit
			? ` It targets \`${request.base}\`, not #${plan.context.pr}'s branch, because the run did not start on that pull request's commit.`
			: ""
	const pushed = git(["push", target, `${head}:refs/heads/${req.branch}`], pushCredentialEnv(env.GH_TOKEN, target))
	if (!pushed.ok && !/rejected|non-fast-forward|already exists/i.test(pushed.err)) {
		return `**Could not open the pull request:** ${pushed.err || "git push failed"}.`
	}
	// The branch may be left from an earlier run; only claim "done" if its pull request exists.
	const owner = REPO.split("/")[0]
	const open = gh(["api", `repos/${REPO}/pulls?head=${encodeURIComponent(`${owner}:${req.branch}`)}&state=open`])
	if (Array.isArray(open) && open.length) {
		return `**Already done:** this job's pull request is already open: ${open[0].html_url}.`
	}
	// Push rejected and no pull request: an earlier run of this job on this commit pushed the
	// branch but couldn't open its pull request, so open it now.
	const create = (body) => ghRaw(["api", `repos/${REPO}/pulls`, "--method", "POST", "--input", "-"], body)
	let opened = create(request)
	// Draft pull requests aren't available on every plan.
	if (opened.status !== 0 && /draft/i.test(`${opened.stdout}${opened.stderr}`)) {
		opened = create({ ...request, draft: false })
	}
	if (opened.status !== 0) {
		return `**Pushed \`${req.branch}\` but could not open the pull request:** ${String(opened.stderr ?? "").trim().split("\n")[0]}.`
	}
	let url = ""
	try {
		url = JSON.parse(opened.stdout)?.html_url ?? ""
	} catch {
		// The link is a nicety.
	}
	return `**Opened a pull request** with this run's changes${url ? `: ${url}` : ` from \`${req.branch}\``}.${leftOutNote}${baseNote}`
}


/** Create or update this run's check on `sha`. */
function postCheck(outcome, view, sha, annotations = [], status = "completed", title = undefined) {
	if (!sha) return
	const waiting = status === "in_progress"
	const payload = {
		name: "Test Companion",
		head_sha: sha,
		status,
		// The closed-PR cancel reads this back to find the run.
		external_id: String(env.GITHUB_RUN_ID ?? ""),
		details_url: RUN_URL,
		output: {
			title: waiting ? (title ?? "Waiting for approval") : outcome,
			// Capped: GitHub rejects a summary over 65,535 characters.
			summary: renderCheckSummary(view),
			...(annotations.length ? { annotations } : {}),
		},
	}
	// A check that is still running must carry no conclusion; GitHub rejects it.
	if (!waiting) payload.conclusion = checkConclusion(outcome)

	// Update this run's existing check rather than adding another.
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

/** Cancel the runs in flight on a commit. Used when a pull request closes unmerged. */
function cancelRunsOn(sha) {
	// Our own check runs, because a comment-triggered run carries the default branch's sha.
	const checks = gh(["api", `repos/${REPO}/commits/${sha}/check-runs?per_page=100`])
	const fromChecks = runIdsFromChecks(checks?.check_runs, { selfRunId: env.GITHUB_RUN_ID })
	// Plus head_sha matches, for pull_request runs whose check isn't posted yet.
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

/** A pull request closed without merging stops its run. Without `actions: write`, warn only. */
function cancelForClosedPr(payload) {
	const sha = payload?.pull_request?.head?.sha
	if (!sha) return
	const { cancelled, forbidden } = cancelRunsOn(sha)
	if (cancelled > 0) {
		// Complete the cancelled run's check so it doesn't stay pending.
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

/** The repository's test framework. Scans two levels, skipping node_modules and dot folders. */
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

/** Open a pull request adding the settings file, so it is reviewed like any other change. */
function openSetupPr(plan, configPath) {
	const framework = scanForFramework()
	const { branch, title, body } = renderSetupPr(configPath, framework)
	const base = settingsRef(readEvent(), env)
	const baseSha = gh(["api", `repos/${REPO}/git/ref/heads/${base}`])?.object?.sha
	if (!baseSha) {
		replyOnPr(plan.context.pr, `I could not read the ${base} branch, so I have not opened anything.`)
		return
	}

	// A branch left from an earlier attempt is fine to reuse.
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

/** Drop unanswered proposals so their in-progress checks don't stay pending. Runs on schedule. */
function sweepExpiredProposals() {
	const prs = flattenPages(gh(["api", `repos/${REPO}/pulls?state=open&per_page=100`, "--paginate", "--slurp"]))
	for (const pr of prs) {
		const sha = pr?.head?.sha
		if (!sha || !pr?.number) continue
		const comments = flattenPages(gh(["api", `repos/${REPO}/issues/${pr.number}/comments`, "--paginate", "--slurp"]))
		if (!proposalNeedsDropping(comments, sha, Date.now(), botLogin)) continue
		// The dropped marker must name the job, or it would end every plan on the commit.
		const stale = findProposal(comments, sha, Date.now(), botLogin)
		// No recorded job means the marker would cover the whole commit. Already expired, so leave it.
		if (!stale?.workflow) {
			notice(`Test Companion: left an untagged stale proposal on #${pr.number} rather than sweeping the whole commit.`)
			continue
		}

		// Complete the proposal's own check rather than adding a second.
		const existing = inFlightCheckId(gh(["api", `repos/${REPO}/commits/${sha}/check-runs?per_page=100`])?.check_runs)
		if (existing) rememberCheck(sha, existing)

		// Could not run maps to action_required, never neutral, which branch protection treats as a pass.
		postCheck(OUTCOMES.COULD_NOT_RUN, { outcome: OUTCOMES.COULD_NOT_RUN, summary: {}, runUrl: RUN_URL }, sha)
		replyOnPr(
			pr.number,
			`That proposal went unanswered, so I have dropped it. The check now says Action required — comment again and I will put up a fresh one.\n\n${proposalDroppedMarkerFor(sha, stale?.workflow)}`,
		)
		notice(`Test Companion: dropped a stale proposal on #${pr.number}.`)
	}
}

/** The bindings for this event, from the CLI. Undefined on failure, which decideGate treats as hold. */
function readBindings(configFile, event, branch) {
	// --branch so `when:` clauses apply, as they do for the run.
	const base = ["workflow", "bindings", "--config", configFile, "--event", event]
	const ask = (extra) =>
		spawnSync("tc", [...base, ...extra, "--json"], {
			encoding: "utf8",
			env: childEnvFor(env),
		})

	let r = branch ? ask(["--branch", branch]) : ask([])
	// Older CLIs lack --branch; read unnarrowed rather than lose the settings block.
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

/** A plain reply. Carries no COMMENT_MARKER, so later runs never overwrite it. */
function replyOnPr(pr, body) {
	if (!pr) return
	gh(["api", `repos/${REPO}/issues/${pr}/comments`, "--method", "POST", "--input", "-"], { body })
}

/** Mark the approved plan spent on the proposal comment, which is never rewritten. Best effort. */
function markPlanSpent(planId, marker) {
	if (!planId || !marker) return
	const current = gh(["api", `repos/${REPO}/issues/comments/${planId}`])
	const body = String(current?.body ?? "")
	if (!body || body.includes(marker)) return
	gh(["api", `repos/${REPO}/issues/comments/${planId}`, "--method", "PATCH", "--input", "-"], { body: `${body}\n\n${marker}` })
}

function postComment(pr, view) {
	// --slurp: without it gh prints one array per page and JSON.parse fails.
	const existing = flattenPages(gh(["api", `repos/${REPO}/issues/${pr}/comments`, "--paginate", "--slurp"]))
	const choice = chooseCommentAction(existing, botLogin)
	// An approved proposal must stop looking like one.
	const body = { body: renderComment(view) + (view.consumedMarker ? `\n${view.consumedMarker}` : "") }
	if (choice.action === "update") {
		gh(["api", `repos/${REPO}/issues/comments/${choice.id}`, "--method", "PATCH", "--input", "-"], body)
	} else {
		gh(["api", `repos/${REPO}/issues/${pr}/comments`, "--method", "POST", "--input", "-"], body)
	}
}

// Unexpected throw: report Could not run, and still exit 0 so the build-effect step decides.
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
		// The commit we posted the in-progress check on, not GITHUB_SHA.
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
