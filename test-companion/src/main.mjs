/**
 * The Action's entry point — STM-3663 Release 2.
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
import { readFileSync, appendFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { planRun, contextArgs, withPullRequestHead, TC_EVENTS } from "./plan-run.mjs"
import { readIntent, INTENT } from "./intent.mjs"
import { chooseRunsToCancel, runIdsFromChecks, latestFailedRun } from "./runs.mjs"
import { decideGate, GATE, describeChangeSize } from "./gate.mjs"
import { mayAsk, describeTestRepoAccess } from "./access.mjs"
import { findTicket } from "./ticket.mjs"
import { childEnvFor } from "./child-env.mjs"
import { appCredentials, signJwt, installationTokenRequest } from "./app-auth.mjs"
import { OUTCOMES, parseSummary, resolveOutcome, checkConclusion, stepShouldFail } from "./outcome.mjs"
import {
	renderJobSummary,
	renderComment,
	chooseCommentAction,
	checkSha,
	renderNotAuthorized,
	renderUnknownRequest,
	findProposal,
	renderProposal,
	renderExtraChecks,
	accessibilityFailsCheck,
	renderApprovedPlan,
	proposalDroppedMarkerFor,
	proposalNeedsDropping,
	flattenPages,
	hasApproverEdits,
	renderProposalBody,
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
	pushCredentialArgs,
	pushUrlFor,
	gitEnvFrom,
	GIT_SAFE_ARGS,
} from "./push-work.mjs"

const env = process.env
const REPO = env.GITHUB_REPOSITORY ?? ""
const RUN_URL = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${REPO}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`
// RUNNER_TEMP, not the system temp dir: GitHub clears RUNNER_TEMP per job, while
// /tmp survives on a self-hosted or reused runner. With fixed names in a shared
// /tmp, `existsSync(RESULT_FILE)` could find an EARLIER job's file and this run
// would report, and upload, test cases it never produced. Falls back to tmpdir()
// so the Action still runs outside a GitHub runner.
const REPORT_DIR = env.RUNNER_TEMP || tmpdir()
const SUMMARY_FILE = join(REPORT_DIR, "test-companion-report.md")
// What the run PRODUCED, as opposed to how it went. Kept separate because the
// two have separate readers: a CI step branches on the summary, a person reads
// the result. For a preview run — which refuses to save by design — this file
// is the only place the generated cases survive (FR-20).
const RESULT_FILE = join(REPORT_DIR, "test-companion-result.md")
// The artifact the result is uploaded under, named here so the report can
// point a reader at it by name. Must match the upload step in action.yml.
const RESULT_ARTIFACT = "test-companion-result"

const setOutput = (k, v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`)
const addToJobSummary = (md) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, md + "\n")
const notice = (m) => console.log(`::notice::${m}`)
const warn = (m) => console.log(`::warning::${m}`)

/** The raw `gh` call, so a caller that cares WHY it failed can look. */
function ghRaw(args, body) {
	return spawnSync("gh", args, {
		encoding: "utf8",
		input: body ? JSON.stringify(body) : undefined,
		env: { ...env, GH_TOKEN: env.GH_TOKEN },
	})
}

/** `gh api`, returning parsed JSON or null. Never throws — reporting must not break a run. */
function gh(args, body) {
	const r = ghRaw(args, body)
	if (r.status !== 0) {
		// A missing permission is a normal, documented outcome (FR-4): skip that
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
 * Sign in as the Test Companion GitHub App, when it is installed — Release 4.
 *
 * Buys exactly three things: the comment and the tick come from "Test
 * Companion" rather than github-actions[bot], the workflow needs no
 * permissions block because the installation token carries the App's own, and
 * an admin can roll the setup out across an organisation at once.
 *
 * It does not run anything (Decision 0). The run still happens on the
 * customer's machine with their BrowserStack credentials.
 *
 * Every failure here falls back to the workflow token rather than stopping. A
 * repository without the App installed is the normal case, not an error, and
 * FR-4 says the run finishes either way.
 */
function appInstallationToken() {
	const creds = appCredentials(env)
	if (!creds) return undefined

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
	const asApp = (args) => spawnSync("gh", args, { encoding: "utf8", env: { ...env, GH_TOKEN: jwt } })

	const found = asApp(["api", `repos/${REPO}/installation`])
	if (found.status !== 0) {
		notice("Test Companion: the GitHub App is not installed on this repository; using the workflow token.")
		return undefined
	}
	let installationId
	try {
		installationId = JSON.parse(found.stdout)?.id
	} catch {
		return undefined
	}
	if (!installationId) return undefined

	// FR-4: "for that repo only". A token minted with no body carries every
	// permission the installation holds across every repository it covers — a
	// run in one repository would hold write access to all of an organisation's.
	const scope = installationTokenRequest(REPO)
	if (!scope) {
		warn(`Could not read "${REPO}" as owner/name, so no scoped App token was requested.`)
		return undefined
	}

	const mint = (body) =>
		spawnSync("gh", ["api", `app/installations/${installationId}/access_tokens`, "--method", "POST", "--input", "-"], {
			encoding: "utf8",
			input: JSON.stringify(body),
			env: { ...env, GH_TOKEN: jwt },
		})

	// An installation granted fewer permissions than we ask for refuses the
	// whole request, so the second attempt drops the permission list and keeps
	// the repository scope — which is the half FR-4 actually requires. Better a
	// token scoped to one repository than a fall back to the workflow token.
	let minted = mint(scope)
	if (minted.status !== 0) {
		minted = mint({ repositories: scope.repositories })
	}
	if (minted.status !== 0) {
		warn("Could not mint a GitHub App token; using the workflow token instead.")
		return undefined
	}

	let token
	try {
		token = JSON.parse(minted.stdout)?.token
	} catch {
		return undefined
	}
	if (!token) return undefined

	// FR-3: credentials are masked in the log. Before the token is used for
	// anything, so there is no window where it could be echoed unmasked.
	console.log(`::add-mask::${token}`)
	return token
}

/**
 * The settings file as it stands on the DEFAULT BRANCH — FR-7.
 *
 * Not the checked-out tree. Read from the branch under test, a pull request can
 * rewrite the rules for its own run and be obeyed — switch itself from preview
 * to live, delete its own spending limit, point its writes elsewhere. Reading
 * from the default branch means an edit counts only once someone merges it.
 *
 * Returns the local path the content was written to, or undefined when there is
 * no settings file there. Fails SAFE: a fetch that errors for any reason is
 * treated as "no settings", which is a clean skip (FR-13) rather than a run
 * governed by whatever happens to be checked out.
 *
 * `--raw` because this is a YAML file, not the JSON envelope gh() parses.
 */
function fetchSettings(path, ref) {
	const r = spawnSync(
		"gh",
		["api", `repos/${REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`, "-H", "Accept: application/vnd.github.raw"],
		{
			encoding: "utf8",
			env: { ...env, GH_TOKEN: env.GH_TOKEN },
		},
	)
	if (r.status !== 0) {
		const first = (r.stderr ?? "").trim().split("\n")[0]
		// A 404 is the ordinary "this repo has no settings file yet" case (FR-13).
		// Anything else is worth saying out loud, because the run is about to skip.
		if (!/404|Not Found/i.test(first)) warn(`Could not read ${path} from ${ref}: ${first}`)
		return undefined
	}
	const local = join(REPORT_DIR, "testcompanion-pipeline.default-branch.yml")
	writeFileSync(local, r.stdout)
	return local
}

/**
 * Whether `login` may ask Test Companion for a run — FR-33.
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
 * Is `login` on `team` in this repository's organisation? — FR-33.
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
function git(args) {
	// A near-empty environment, and no hooks. These run AFTER the agent, which
	// has had --yolo write access to the tree: a planted .git/hooks/pre-commit
	// would otherwise be executed by our own `git commit` with the App's
	// private key and the customer's credentials in its environment.
	const r = spawnSync("git", [...GIT_SAFE_ARGS, ...args], { encoding: "utf8", env: gitEnvFrom(env) })
	// `raw` is deliberate. `git status --porcelain` puts a SPACE in the first
	// column for an unstaged modification, and trimming the whole output eats
	// it on the first line — which cost run 40845669513 ten passing tests.
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

/** Nothing to do. Report it plainly and let the step pass — FR-3, FR-13. */
function finishSkipped(reason, detail) {
	const human = {
		"not-a-pull-request": "That comment was on an issue, not a pull request.",
		"not-addressed-to-us": "No @test-companion mention, so nothing was asked of Test Companion.",
		"proposal-superseded": "The plan being approved was for an earlier commit, so it was not run.",
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
		// FR-4: name the permission and the line to add. The commonest cause by
		// far is a workflow without `pull-requests: read` — the lookup 403s, the
		// head commit is unknown, and the run fails closed. Said plainly here
		// because "nothing safe to run against" sends a reader looking at their
		// pull request rather than at their permissions block.
		"no-pr-head":
			"Could not read that pull request, so there is no commit it is safe to run against. " +
			"If this workflow has no `pull-requests: read` permission, add it.",
		"not-authorized": "Only someone with write access to this repository can ask Test Companion for a run.",
		"unmapped-request": "That comment did not name anything Test Companion can do; it was answered in the thread.",
		stopped: "Stopped, as asked.",
		"not-bound": "That job is not bound to pull request comments in this repository.",
		"nothing-to-approve": "Nothing is waiting for approval on this commit.",
		"proposal-expired": "That proposal was more than a day old and has been dropped.",
		proposed: "Proposed, and waiting for someone to reply go.",
		"setup-requested": "Opened a pull request adding the settings file.",
	}[reason]
	const msg = human ?? `Nothing to do (${reason}).`
	notice(`Test Companion: ${msg}`)
	addToJobSummary(`## Test Companion\n\n${msg}${detail ? `\n\n\`${detail}\`` : ""}`)
	setOutput("outcome", "Skipped")
	setOutput("should-fail", "false")
	process.exit(0)
}

/**
 * FR-13: no settings file means a clean pass and the file they need.
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

function main() {
	// Release 4: act as the App when it is installed, so the comment and the
	// tick carry Test Companion's name. Before anything else talks to GitHub.
	const appToken = appInstallationToken()
	if (appToken) {
		env.GH_TOKEN = appToken
		notice("Test Companion: acting as the GitHub App.")
	}

	// FR-3: a run without credentials does nothing, says so, and passes. This is
	// the normal shape of a fork pull request, not an error.
	if (!env.BROWSERSTACK_USERNAME || !env.BROWSERSTACK_ACCESS_KEY) {
		finishSkipped("no-credentials")
	}

	// Before the plan, so a repository with no pipeline file gets the starter
	// rather than whatever the planner happens to say about this event.
	const configPath = pipelineConfigPath(env.TC_ACTION_CONFIG, env)
	// FR-7: from the default branch, never from the branch under test.
	// May be undefined — a repository with no settings file is a normal, and
	// very common, first run (FR-13). It is NOT an early exit any more: a
	// comment asking us to add that file is the one thing worth doing in a
	// repository that has none, and the exit used to sit in front of it.
	// Nothing below costs money before the settings check further down.
	const settingsFile = fetchSettings(configPath, settingsRef(readEvent(), env))

	// FR-44: before anything else this run does, clear out proposals that ran
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
		// FR-36: closing a pull request without merging stops whatever it started.
		if (plan.skip.reason === "closed-unmerged") cancelForClosedPr(readEvent())
		finishSkipped(plan.skip.reason, plan.skip.detail)
	}

	// FR-33: only someone who can write to the repository may ask for a run by
	// commenting. On a public repository anyone can comment, and a run executes
	// an agent with --yolo against the customer's own machine and credentials,
	// so this gate is the whole access-control story for the comment trigger.
	//
	// Fails CLOSED: if the permission lookup itself fails — no token, API down,
	// rate limited — the run does not start. An unanswerable "may they?" is a no.
	// Keyed on the TRIGGER, not only on a flag the planner sets. A planner change
	// that forgets the flag would otherwise delete this gate silently, and the
	// failure would be invisible: runs would simply start working for people who
	// should not be able to start them.
	// A comment names an issue, not a commit. Look the pull request up so the
	// run works on ITS head rather than the default branch, and so the check
	// lands on that commit. Fails closed on a fork, like every other untrusted
	// trigger (review finding, PR #3030).
	let pull
	if (!plan.context?.sha && plan.context?.pr) {
		pull = gh(["api", `repos/${REPO}/pulls/${plan.context.pr}`])
		plan = withPullRequestHead(plan, pull, REPO)
		if (plan.skip) finishSkipped(plan.skip, `PR #${plan.context.pr}`)
		// Work on the commit that was asked about. The starter checks out the
		// default branch for a comment event, since the payload names no ref.
		const co = spawnSync("git", ["fetch", "--depth", "1", "origin", plan.context.sha], { stdio: "inherit" })
		if (co.status === 0) {
			spawnSync("git", ["checkout", "--detach", "FETCH_HEAD"], { stdio: "inherit" })
		} else {
			warn(`Could not fetch ${plan.context.sha}; running against the checked-out tree.`)
		}
	}

	// FR-37: the ticket this change is for, so the run tests against what the
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

	// Read once, before the access check: FR-33's team narrowing lives in the
	// same document as FR-43's approval gate.
	const bindingsDoc = settingsFile && plan.event ? readBindings(settingsFile, plan.event, plan.context?.branch) : undefined
	const askTeam = bindingsDoc?.settings?.ask_team

	// Only issue_comment. `pull_request_review_comment` was listed here too,
	// but route() has no case for it, so such an event skips as
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
		// FR-33: write access is the floor, and the pipeline file may narrow it
		// to a team. It may never widen it — see mayAsk.
		const allowed = mayAsk({
			hasWriteAccess: hasWriteAccess(who),
			askTeam,
			inTeam: askTeam ? isOnTeam(who, askTeam) : undefined,
		})
		if (!allowed) {
			// FR-33 wants a one-line reply, not a line in a log the person who
			// asked will never open.
			replyOnPr(plan.context?.pr, renderNotAuthorized(who ?? "there", askTeam))
			finishSkipped("not-authorized", who)
		}
	}

	// FR-34: work out what the comment actually asked for, here, before the CLI
	// is spawned — a request we cannot place has to cost nothing.
	let proposing = false
	let approvalNote = ""
	if (plan.event === TC_EVENTS.PR_COMMENT) {
		// FR-34: pass what this repository has actually bound, so a job can be
		// asked for by name and not only by the phrases written into PHRASES.
		const intent = readIntent(plan.context.instructions, {
			workflows: (bindingsDoc?.bindings ?? []).filter((b) => b.enabled).map((b) => b.workflow),
		})

		if (intent.kind === INTENT.UNKNOWN) {
			replyOnPr(plan.context.pr, renderUnknownRequest())
			finishSkipped("unmapped-request")
		}
		// Answered before anything starts. Falling through would be the worst
		// possible reading of "stop": the person asks for the run to end and a
		// new one begins.
		if (intent.kind === INTENT.STOP) {
			stopRuns(plan, plan.commenter ?? "you")
			finishSkipped("stopped")
		}
		if (intent.kind === INTENT.SETUP) {
			openSetupPr(plan, configPath)
			finishSkipped("setup-requested")
		}

		// A named job narrows what the binding would otherwise choose. The event
		// is kept, so the binding still governs result mode and limits — asking
		// by comment must not be a way around the repository's own settings.
		if (intent.workflow) plan.workflow = intent.workflow

		// `rca`, `fix` and `verdict` need to know WHICH build failed. A
		// build_failed trigger is handed the run; a COMMENT is not, so these
		// three used to fail on the first comment with "Could not run" — while
		// we advertise all three by name.
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

		const bindings = bindingsDoc
		const binding = pickBinding(bindings, intent.workflow)

		// FR-34 asks for any BOUND workflow. Saying so now beats a preview run,
		// a proposal, a "go", and only then "no binding for pr_comment".
		if (intent.workflow && bindings && !binding) {
			replyOnPr(
				plan.context.pr,
				`\`${intent.workflow}\` is not bound to pull request comments in this repository, so nothing ran. Bind it in \`${configPath}\` under \`on: pr_comment\`.`,
			)
			finishSkipped("not-bound", intent.workflow)
		}

		const comments = flattenPages(gh(["api", `repos/${REPO}/issues/${plan.context.pr}/comments`, "--paginate", "--slurp"]))
		const waiting = findProposal(comments, plan.context.sha)

		// An unaddressed comment only ever reaches us as a possible approval.
		// With nothing waiting, it is what it looked like: a person talking to
		// each other, not to us.
		//
		// Unless a plan we put up has been left behind by a newer commit. Then
		// they were talking to us, they used a word we accept, and telling them
		// "no @test-companion mention" is both wrong and unhelpful — the reason
		// is sitting in the comment history (FR-44).
		if (plan.approvalOnly && !waiting) {
			const stale = findSupersededProposal(comments, plan.context.sha)
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
		})

		if (gate.action === GATE.NOTHING_TO_APPROVE) {
			replyOnPr(
				plan.context.pr,
				"There is nothing waiting for approval on this commit. Ask for a job by name and I will propose one.",
			)
			finishSkipped("nothing-to-approve")
		}
		if (gate.action === GATE.EXPIRED) {
			// FR-44: dropped after 24 hours. Enforced on the approving side, so a
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
			// from the event alone — whichever binding came first in the file —
			// and a `fix` proposal could run something else, live, with --yolo.
			if (waiting?.workflow) plan.workflow = waiting.workflow

			// FR-43: the run carries out the approved plan — the proposal as the
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
			// FR-44: too big to cover in one go — say so to the run, which then
			// covers what matters and lists what it left out.
			const size = describeChangeSize(pull)
			if (size.large) {
				plan.context.focus = `${size.files} files and ${size.lines} changed lines`
			}
		}

		proposing = gate.action === GATE.PROPOSE
		// FR-43: a planning pass has to KNOW it is one. Without this it attempts
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
	}

	// FR-13: no settings file means a clean pass and the file they need. Checked
	// before anything that costs money or time — the comment handling above
	// spends only API calls, and "set up this repo" has to be reachable from here.
	if (!settingsFile) {
		finishWithStarter(configPath)
	}

	// An event-driven run names no job: the pipeline file decides, via --event.
	// A manual run names one and carries no event, which is how the CLI is told
	// to ignore the bindings entirely.
	// A manual run names its job. An event-driven run does NOT: which job an
	// event runs is the pipeline file's decision, so the Action passes only
	// --event and lets the CLI resolve the binding. Guessing a name here was the
	// first live run's failure — it produced `no binding for "pr_opened"
	// (workflow "test")` because the repo had bound `generate`, not `test`.
	const args = ["workflow", "run"]
	if (plan.workflow) args.push(plan.workflow)
	if (plan.event) args.push("--event", plan.event)
	// One flag per pair. A single joined value is parsed by pflag with
	// encoding/csv, where one double quote anywhere — `Fix "Pay now" button` —
	// fails the whole flag and the run reports "Could not run".
	args.push(...contextArgs(plan.context))
	if (plan.preview) args.push("--preview")
	// The fetched copy, not whatever the checkout holds — FR-7.
	args.push("--config", settingsFile)
	args.push("--json", "--yolo", "--summary-file", SUMMARY_FILE, "--result-file", RESULT_FILE)

	// The run must happen on the commit it is about. On an `issue_comment`
	// event GitHub checks out the DEFAULT branch — a live run on 2026-10-27
	// wrote eight tests for a pull request branch into a checkout of the
	// default one. The starter workflow cannot be amended once customers have
	// merged it, so the Action puts itself on the right commit.
	//
	// Read-only with respect to the remote, and advisory: a checkout we cannot
	// do is reported and the run continues against whatever is here, because a
	// proposal built from the diff is still worth having.
	// Every arm fails CLOSED, and each is read from the world rather than
	// asserted. An earlier draft hard-coded sameRepo on the reasoning that
	// plan-run.mjs already skips forks — true today, and exactly the shape
	// that goes quietly wrong when the code around it moves. The same
	// fail-open bug had already appeared once in this Action, on
	// `pull_request_target` with a deleted fork.
	// Put the tree on the commit under review, when nothing else already has.
	//
	// Where a comment names an issue, the block above already fetched the head
	// sha and detached onto it. A pull_request event is different: GitHub
	// checks out the MERGE commit, and nothing corrects that — so without this
	// a synchronize-triggered run reads, and would push, merged content rather
	// than the branch.
	//
	// No --depth. On a repository cloned with fetch-depth 0 a shallow fetch
	// makes a COMPLETE clone shallow, taking history away from the agent and
	// from tc's dedupe claim.
	//
	// Advisory: a checkout we cannot do is reported and the run continues
	// against whatever is here, because a proposal built from the diff is
	// still worth having. shouldPushWork re-checks before anything is pushed.
	if (
		plan.context.branch &&
		plan.context.sha &&
		needsCheckout({ headSha: git(["rev-parse", "HEAD"]).out, wantSha: plan.context.sha })
	) {
		const fetched = git(["fetch", "origin", plan.context.sha])
		const moved = fetched.ok && git(["checkout", "-B", plan.context.branch, plan.context.sha]).ok
		if (moved) notice(`Working on ${plan.context.branch} at ${String(plan.context.sha).slice(0, 7)}.`)
		else warn(`Could not check out ${plan.context.branch}; the run sees whatever this job checked out.`)
	}

	const saving = shouldPushWork({
		preview: plan.preview,
		// From whichever source THIS trigger actually has. A comment names an
		// issue, so `pull` was fetched to resolve a head sha; a pull_request
		// event carries the head on its own payload and nothing is fetched.
		// Reading only `pull` refused every pull_request-triggered push
		// (run 40857884973, on a branch in this very repository).
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

	// FR-35: the handle a later `stop` needs. Posted BEFORE the run, because a
	// check written at the end cannot help cancel the run that is writing it —
	// which is why `stop` found nothing to stop until now. It also makes FR-48's
	// "the check shows while it runs" true for every run rather than only a
	// proposal.
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
	// own machine (FR-3).
	const run = spawnSync("tc", args, { stdio: "inherit", encoding: "utf8", env: childEnvFor(env) })
	const exitCode = run.status ?? 1

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

	// FR-42: a configured write that could not happen is said out loud, naming
	// what is missing — a silent skip reads as "there was nothing to write".
	const warnings = []
	const testsRepo = bindingsDoc?.settings?.tests_repo
	if (testsRepo) {
		const probe = gh(["api", `repos/${testsRepo}`])
		const access = describeTestRepoAccess({ testsRepo, thisRepo: REPO, canPush: probe?.permissions?.push })
		if (!access.ok) warnings.push(access.message)
	}

	// FR-45: silent unless the settings asked for them.
	const extraChecks = renderExtraChecks(summary, {
		wcag: bindingsDoc?.settings?.wcag,
		visual: bindingsDoc?.settings?.visual,
	})

	// FR-43: the approved work must outlive the runner. Until this existed
	// nothing carried it off the machine — the CLI opens a pull request only
	// for `automate` and `fix`, so an approved `test-pr` run wrote eight
	// passing tests and lost all eight.
	const workNote = saveWork(saving, plan)

	const view = {
		workflow: plan.workflow ?? summary.workflow,
		workNote,
		extraChecks,
		warnings,
		outcome,
		summary,
		runUrl: RUN_URL,
		// FR-2: two runs a week apart on the same pinned version must report the
		// same CLI version, which means showing it.
		cliVersion: summary.cli_version || env.TC_ACTION_CLI_VERSION,
		resultArtifact: hasResult ? RESULT_ARTIFACT : undefined,
		failedTests,
	}
	// FR-43: a held request posts what it WOULD do and ends. The run that
	// produced this was a preview run, so nothing has been written.
	if (proposing) {
		const sha = checkSha(plan.context, summary, env.GITHUB_SHA)
		addToJobSummary(renderJobSummary(view))
		// FR-44: say when the change is too big to test in one go, so the
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
				renderProposalBody({ summary: renderJobSummary(view), plan: planBody, sizeNote }),
				sha,
				plan.commenter,
				// FR-43: record WHICH job this proposal is for, so approving it
				// cannot run a different one.
				plan.workflow ?? summary.workflow,
			),
		)
		// FR-44: the check shows in progress while the proposal waits.
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

	// FR-28: each failing test on the line it is declared on, so a reviewer sees
	// it in the files-changed view instead of having to open the run's logs.
	// Empty whenever the reporter printed no locator, which is every mocha run —
	// those failures are named in the report instead.
	const annotations = buildAnnotations(failedTests)
	// FR-45: accessibility may turn the check red, but ONLY when the settings
	// say so and only for violations this change introduced. The step's own
	// result is untouched — that follows the build effect (FR-9).
	const checkOutcome =
		outcome === OUTCOMES.SUCCEEDED &&
		accessibilityFailsCheck(summary, {
			wcag: bindingsDoc?.settings?.wcag,
			failOnNew: bindingsDoc?.settings?.fail_on_new,
		})
			? OUTCOMES.TESTS_FAILED
			: outcome
	postCheck(checkOutcome, view, checkSha(plan.context, summary, env.GITHUB_SHA), annotations)
	if (plan.context.pr) postComment(plan.context.pr, { ...view, approvalNote })

	// Always exit 0. Whether the build goes red is the build effect's call, and
	// a separate step applies it — otherwise the report never gets attached.
	process.exit(0)
}

/**
 * Commit what the run wrote, onto the pull request's own branch — FR-42's
 * "tests go in the pull request's own repository" applied to the run that
 * produced them.
 *
 * A commit on the branch rather than a second pull request: someone who asked
 * for tests on their change wants them on their change, not in a review queue
 * behind it.
 *
 * Returns the line for the comment, or undefined when there was nothing to
 * save. Never throws and never fails the run — the report is the product here,
 * and a failed push that takes the whole run down loses the report too.
 */
function saveWork(saving, plan) {
	if (!saving.ok) return undefined
	// `-c core.quotePath=false` stops git octal-escaping non-ASCII bytes, so a
	// path like café.spec.ts arrives as itself. unquote() decodes the escapes
	// anyway, but not producing them is the better half of the fix.
	const status = git(["-c", "core.quotePath=false", "status", "--porcelain"])
	if (!status.ok) return undefined
	const { push, skip } = splitPushable(changedPaths(status.raw))
	if (push.length === 0) return undefined

	const branch = plan.context.branch
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
	if (!target) return renderPushNote({ branch, files: push, skipped: skip, error: `cannot push: bad repository name "${REPO}"` })
	const pushed = git([...pushCredentialArgs(env.GH_TOKEN, target), "push", target, `HEAD:refs/heads/${branch}`])
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

/** FR-48: one check, never neutral. FR-28: each failing test on its own line. */
function postCheck(outcome, view, sha, annotations = [], status = "completed", title = undefined) {
	if (!sha) return
	const waiting = status === "in_progress"
	const payload = {
		name: "Test Companion",
		head_sha: sha,
		status,
		// Which run this check belongs to. FR-35's `stop` reads it back: the
		// check is posted on the PULL REQUEST's head commit, which is the one
		// thing that reliably ties a run to the pull request it is about.
		external_id: String(env.GITHUB_RUN_ID ?? ""),
		details_url: RUN_URL,
		output: {
			title: waiting ? (title ?? "Waiting for approval") : outcome,
			summary: renderJobSummary(view),
			...(annotations.length ? { annotations } : {}),
		},
	}
	// A check that is still running must carry no conclusion; GitHub rejects it.
	if (!waiting) payload.conclusion = checkConclusion(outcome)

	// Update the check this run already made for this commit, rather than
	// adding another. A run posts up to three times — in progress, the result,
	// and the catch-all on a crash — so posting every time left two or three
	// checks of the same name, and a proposal's in-progress one pending
	// forever. FR-48 asks for one.
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
 * End the runs in flight on this commit — FR-35.
 *
 * The 30-second deadline in FR-35 is why this is a cancel call rather than a
 * flag the next run would notice: asking GitHub to cancel is the only thing
 * that stops work already underway.
 */
function cancelRunsOn(sha) {
	// Our own check runs on this commit, NOT `actions/runs?head_sha=`. A run
	// started by an issue_comment carries the DEFAULT BRANCH's sha, so that
	// query matched nothing and neither `stop` nor a closed pull request ever
	// cancelled anything (verified live, 2026-10-29).
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
 * FR-36: a pull request closed without merging stops its run.
 *
 * Without the permission to cancel, FR-36 says the run finishes and the comment
 * says it ran on a closed pull request — so this warns and lets it be, rather
 * than failing anything.
 */
function cancelForClosedPr(payload) {
	const sha = payload?.pull_request?.head?.sha
	if (!sha) return
	const { cancelled, forbidden } = cancelRunsOn(sha)
	if (cancelled > 0) {
		notice(`Test Companion: stopped ${cancelled} run(s) — the pull request was closed without merging.`)
	} else if (forbidden) {
		warn("Could not stop the run for a closed pull request: this workflow needs `actions: write`.")
	}
}

function stopRuns(plan, who) {
	const sha = plan.context?.sha
	const pr = plan.context?.pr
	const { found, cancelled, forbidden } = cancelRunsOn(sha)

	if (found === 0) {
		replyOnPr(pr, "Nothing of mine is running on this commit, so there was nothing to stop.")
		return
	}

	// FR-35: without the permission, say which one is missing rather than
	// reporting a stop that did not happen.
	if (cancelled === 0) {
		replyOnPr(
			pr,
			forbidden
				? "I could not stop that run — this workflow needs `actions: write` to cancel a run."
				: "I could not stop that run. It may have finished already.",
		)
		return
	}
	replyOnPr(pr, `Stopped by @${who}.`)
}

/**
 * Which test framework the checked-out repository uses — FR-13.
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
 * Open the pull request that adds the settings file — FR-13.
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
 * Drop proposals nobody answered — FR-44.
 *
 * This is what makes FR-44's in-progress check safe to post at all. A proposal
 * that is never replied to would otherwise leave that check unresolved for the
 * life of the pull request, and anyone who made "Test Companion" a required
 * check is then blocked by a check that never arrives — the same failure
 * Release 2 avoided by posting the tick at the END of a run.
 *
 * Runs on the nightly schedule, alongside whatever else is bound to it.
 */
function sweepExpiredProposals() {
	const prs = flattenPages(gh(["api", `repos/${REPO}/pulls?state=open&per_page=100`, "--paginate", "--slurp"]))
	for (const pr of prs) {
		const sha = pr?.head?.sha
		if (!sha || !pr?.number) continue
		const comments = flattenPages(gh(["api", `repos/${REPO}/issues/${pr.number}/comments`, "--paginate", "--slurp"]))
		if (!proposalNeedsDropping(comments, sha)) continue

		// Complete the check the PROPOSAL run left in progress, rather than
		// adding a second one beside it. The sweep is a different process with
		// an empty memo, so without this lookup the proposal's check stayed
		// pending for the life of the branch — the "blocked by a check that
		// never arrives" failure this sweep exists to prevent.
		const existing = inFlightCheckId(gh(["api", `repos/${REPO}/commits/${sha}/check-runs?per_page=100`])?.check_runs)
		if (existing) rememberCheck(sha, existing)

		// "Action required", per FR-44 — checkConclusion already maps Could not run
		// to exactly that, and never to neutral, which branch protection reads as a pass.
		postCheck(OUTCOMES.COULD_NOT_RUN, { outcome: OUTCOMES.COULD_NOT_RUN, summary: {}, runUrl: RUN_URL }, sha)
		replyOnPr(
			pr.number,
			`That proposal went a day without a reply, so I have dropped it. The check now says Action required — comment again and I will put up a fresh one.\n\n${proposalDroppedMarkerFor(sha)}`,
		)
		notice(`Test Companion: dropped a stale proposal on #${pr.number}.`)
	}
}

/**
 * What the pipeline file binds to this event, with every value resolved — FR-43.
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
 * A plain reply in the thread — FR-33, FR-34.
 *
 * Deliberately NOT the tracked run comment: it carries no COMMENT_MARKER, so a
 * later run neither overwrites a refusal nor adopts one as the place it reports.
 */
function replyOnPr(pr, body) {
	if (!pr) return
	gh(["api", `repos/${REPO}/issues/${pr}/comments`, "--method", "POST", "--input", "-"], { body })
}

/** FR-29: one comment, edited in place. */
function postComment(pr, view) {
	// `--slurp` matters: without it `gh --paginate` prints ONE JSON ARRAY PER
	// PAGE, so the output of a pull request with more than 30 comments is
	// `[...][...]`, JSON.parse throws, gh() returns null and `existing` becomes
	// []. Every run then posted a NEW comment instead of editing its own, which
	// is the single-comment guarantee in FR-29 (review finding, PR #3030).
	const existing = flattenPages(gh(["api", `repos/${REPO}/issues/${pr}/comments`, "--paginate", "--slurp"]))
	const choice = chooseCommentAction(existing)
	const body = { body: renderComment(view) }
	if (choice.action === "update") {
		gh(["api", `repos/${REPO}/issues/comments/${choice.id}`, "--method", "PATCH", "--input", "-"], body)
	} else {
		gh(["api", `repos/${REPO}/issues/${pr}/comments`, "--method", "POST", "--input", "-"], body)
	}
}

// Spec section "The package itself crashes after the job finishes": the
// customer gets no tick and no comment, which is WORSE than a red tick —
// anyone who made the check required is blocked by a check that never arrives,
// with nothing on the pull request saying why.
//
// finishSkipped and the normal path both exit(0) from inside main, so reaching
// the catch at all means something unexpected threw. Report it as "Could not
// run", which is precisely what happened, and still exit 0 so the build-effect
// step is what decides whether the build goes red.
try {
	main()
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
		postCheck(OUTCOMES.COULD_NOT_RUN, { outcome: OUTCOMES.COULD_NOT_RUN, summary: {}, runUrl: RUN_URL }, env.GITHUB_SHA)
	} catch {
		// Nothing left to try. The job summary above is still written.
	}
	process.exit(0)
}
