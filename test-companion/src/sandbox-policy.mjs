/**
 * The rules for running the agent as a separate, locked-down user.
 *
 * Why this exists. The agent runs shell commands it chooses, and anything in
 * the pull request, the build logs or the app can try to steer it. On a
 * GitHub-hosted runner it used to run as the same user as this Action, and a
 * test on a real runner showed what that means:
 *
 * - any program can read the startup environment of another program run by
 *   the same user, so the agent could read the token and the App key out of
 *   this Action's own process, even though we never passed them to it;
 * - the job's user has admin rights with no password, and with them the
 *   agent found secrets in the memory of the runner's own worker process.
 *
 * Running it as a different user with no admin rights closes both: Linux
 * does not let one user read another's processes or private files.
 *
 * Everything here is a pure function. The commands that act on the machine
 * live in sandbox.mjs.
 */

/** The locked-down user the agent runs as. */
export const AGENT_USER = "tc-agent"

/**
 * Where the agent works. Outside every home folder on purpose: the runner's
 * home holds the job's temp files, gh's signed-in config and the runner's own
 * credentials, so the agent is never given a way into it.
 *
 * - `work` is the checked-out repository, mounted here so the agent never
 *   needs to walk through the runner's home to reach it.
 * - `in` holds files we hand the agent (the settings, an approved plan).
 *   Ours; the agent can only read it.
 * - `out` holds the files the agent's run writes for us (the report, the
 *   result, a pull request to open). The agent's; we read it carefully.
 * - `relay` holds the socket the agent's `gh` talks to.
 * - `tmp` is the agent's own temp folder.
 */
export function sandboxLayout(root = "/var/tmp/tc-agent", home = `/home/${AGENT_USER}`) {
	return {
		root,
		home,
		work: `${root}/work`,
		in: `${root}/in`,
		out: `${root}/out`,
		relay: `${root}/relay`,
		socket: `${root}/relay/gh.sock`,
		tmp: `${root}/tmp`,
		bin: `${home}/.local/bin`,
		ghConfig: `${home}/.config/gh`,
	}
}

/**
 * The environment the agent's run gets: the usual allowlisted one, pointed at
 * the agent's own folders instead of ours.
 *
 * GH_CONFIG_DIR is the important override. Ours holds a real token; the
 * agent's holds a placeholder and the relay socket, so its `gh` reads work
 * and it never sees a pass. RUNNER_TEMP and TMPDIR are moved because ours are
 * inside the runner's home, which the agent cannot reach.
 */
export function agentEnvFrom(childEnv, layout, extra = {}) {
	const env = { ...childEnv }
	env.HOME = layout.home
	env.USER = AGENT_USER
	env.LOGNAME = AGENT_USER
	env.GH_CONFIG_DIR = layout.ghConfig
	env.RUNNER_TEMP = layout.tmp
	env.TMPDIR = layout.tmp
	// The agent's own bin first: that is where its copy of the CLI lives. The
	// rest of PATH is kept for the customer's toolchain (setup-node, Java,
	// Python and so on install under /opt, which every user can read).
	env.PATH = [layout.bin, ...String(childEnv.PATH ?? "/usr/bin:/bin").split(":").filter((p) => p && p !== layout.bin)].join(":")
	env.GH_NO_UPDATE_NOTIFIER = "1"
	env.GH_PROMPT_DISABLED = "1"
	return { ...env, ...extra }
}

/**
 * The command that runs `command args` as the agent user.
 *
 * `setpriv` swaps to the agent's user and group and drops every other group,
 * so nothing of the runner's identity comes along. `--reset-env` and `env -i`
 * start from an empty environment. `env -C` moves into the mounted checkout.
 *
 * The environment itself is NOT on this command line. sudo writes the command
 * line it runs to the machine's log, and on a self-hosted runner that log
 * outlives the job, so the BrowserStack key would sit in it. Instead the
 * launcher reads the environment from `envFile` (readable only by the agent's
 * user), deletes it, and starts the command with it.
 */
export function asAgentCommand({ node, launcher, envFile, cwd, command, args }) {
	return {
		command: "/usr/bin/sudo",
		args: [
			"-n",
			"setpriv",
			`--reuid=${AGENT_USER}`,
			`--regid=${AGENT_USER}`,
			"--init-groups",
			"--reset-env",
			"--",
			"env",
			"-i",
			"-C",
			cwd,
			"PATH=/usr/bin:/bin",
			node,
			launcher,
			envFile,
			command,
			...args,
		],
	}
}

/**
 * The launcher asAgentCommand runs: read the environment, delete its file,
 * start the command with it, and pass its exit code back. Output is
 * inherited, so the run's live log and answer capture work unchanged.
 */
export const LAUNCHER_SOURCE = `import { readFileSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
const [envFile, command, ...args] = process.argv.slice(2)
const env = JSON.parse(readFileSync(envFile, "utf8"))
rmSync(envFile, { force: true })
const child = spawn(command, args, { stdio: "inherit", env })
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s))
child.on("error", () => process.exit(127))
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
`

/**
 * Whether the relay passes a request from the agent's `gh` on to GitHub.
 *
 * Reads only. Everything the agent legitimately needs from GitHub is a read:
 * a failed run's logs and artifacts, earlier runs, a pull request's details
 * and diff. Every write the run needs is done by this Action itself, after
 * the run, with checks the agent cannot skip.
 *
 * - GET and HEAD to the API are allowed. The pass the relay adds is scoped to
 *   this one repository, so the agent cannot read anyone else's code through
 *   it either.
 * - POST is allowed only to /graphql, and only for a query. gh reads pull
 *   requests through GraphQL, and GraphQL sends reads and writes the same way,
 *   so the body decides.
 * - GET to any other host is allowed WITHOUT the pass. Log and artifact
 *   downloads redirect to storage hosts with their own signed URLs, and
 *   gh sends the redirect through the relay too. The agent can reach the
 *   internet anyway, so passing these on gives it nothing new.
 * - Everything else is refused.
 */
export function relayDecision({ method, host, path, body }) {
	const m = String(method ?? "").toUpperCase()
	const h = String(host ?? "")
		.toLowerCase()
		.replace(/:443$/, "")
	const p = String(path ?? "")
	const api = h === "api.github.com"
	if (!p.startsWith("/")) return { allow: false, why: "a path must start with /" }
	if (api && (m === "GET" || m === "HEAD")) return { allow: true, auth: true }
	if (api && m === "POST" && (p === "/graphql" || p.startsWith("/graphql?"))) {
		return isReadOnlyGraphql(body)
			? { allow: true, auth: true }
			: { allow: false, why: "only GraphQL queries are passed on, never mutations" }
	}
	if (!api && h && (m === "GET" || m === "HEAD")) {
		// Never github.com itself: with a pass that would be the web UI, and
		// without one there is nothing there the run needs.
		if (h === "github.com" || h.endsWith(".github.com")) {
			return { allow: false, why: `${h} is not passed on` }
		}
		return { allow: true, auth: false }
	}
	return { allow: false, why: `${m} to ${h || "an unknown host"} is not passed on` }
}

/**
 * Whether a GraphQL request body only reads.
 *
 * A GraphQL document is a list of operations. Each starts with `query`,
 * `mutation` or `subscription`, or with `{` (shorthand for a query), and may
 * also hold `fragment` definitions. We strip strings and comments so a word
 * inside them cannot fool us, then look at what starts each top-level
 * definition. Anything we cannot read cleanly counts as a write.
 */
export function isReadOnlyGraphql(body) {
	let doc
	try {
		const parsed = JSON.parse(String(body ?? ""))
		// A batch of several requests in one body: every one must be a query.
		if (Array.isArray(parsed)) return parsed.length > 0 && parsed.every((one) => isReadOnlyGraphql(JSON.stringify(one)))
		doc = parsed?.query
	} catch {
		return false
	}
	if (typeof doc !== "string" || doc.trim() === "") return false
	const stripped = doc
		.replace(/"""[\s\S]*?"""/g, '""')
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/#[^\n\r]*/g, "")
	let depth = 0
	let i = 0
	while (i < stripped.length) {
		const c = stripped[i]
		if (c === "{") {
			depth++
			i++
			continue
		}
		if (c === "}") {
			depth--
			if (depth < 0) return false
			i++
			continue
		}
		if (depth === 0 && /[A-Za-z_]/.test(c)) {
			const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(stripped.slice(i))[0]
			if (word === "mutation" || word === "subscription") return false
			if (word !== "query" && word !== "fragment" && !inDefinitionHead(stripped, i)) return false
			i += word.length
			continue
		}
		i++
	}
	return depth === 0
}

/**
 * Inside `query Name($a: Int) @dir` or `fragment F on Type`, the words after
 * the keyword are names, types and directives, not new operations. True when
 * the nearest keyword before position i, at the top level, is query or
 * fragment and no `{` has opened since.
 */
function inDefinitionHead(text, i) {
	const before = text.slice(0, i)
	const lastOpenOrClose = Math.max(before.lastIndexOf("{"), before.lastIndexOf("}"))
	const head = before.slice(lastOpenOrClose + 1)
	return /\b(query|fragment)\b/.test(head)
}

/**
 * The CLI's request to open a pull request, checked before we act on it.
 *
 * The agent's run writes this file and the agent can change it, so nothing
 * in it is trusted: the branch must be the CLI's own naming for this job and
 * commit, the base must be a plain branch name, and the title and body are
 * capped. Returns the cleaned request, or { error } saying why it was refused.
 */
export function checkPrHandoff(text, { sha } = {}) {
	let req
	try {
		req = JSON.parse(String(text ?? ""))
	} catch {
		return { error: "the pull request request was not valid JSON" }
	}
	if (!req || typeof req !== "object") return { error: "the pull request request was empty" }
	const workflow = String(req.workflow ?? "")
	const commit = String(req.sha ?? "")
	const branch = String(req.branch ?? "")
	const base = String(req.base ?? "")
	if (!/^(automate|fix)$/.test(workflow)) return { error: `no pull request is opened for "${workflow}"` }
	if (!/^[0-9a-f]{7,40}$/.test(commit)) return { error: "the commit in the request is not a commit id" }
	if (sha && commit !== sha) return { error: "the request is for a different commit than this run" }
	if (branch !== `tc/${workflow}/${commit}`) return { error: `the branch "${branch}" is not the one this job uses` }
	if (!isPlainBranchName(base)) return { error: `"${base}" is not a branch name we will open a pull request against` }
	const title = String(req.title ?? "").slice(0, 256)
	const body = String(req.body ?? "").slice(0, 60000)
	return { workflow, sha: commit, branch, base, title: title || `tc ${workflow}: ${commit}`, body }
}

/** A branch name with nothing git or a URL could read as something else. */
export function isPlainBranchName(name) {
	const n = String(name ?? "")
	return (
		n.length > 0 &&
		n.length <= 200 &&
		/^[A-Za-z0-9._/-]+$/.test(n) &&
		!n.startsWith("-") &&
		!n.startsWith("/") &&
		!n.endsWith("/") &&
		!n.endsWith(".") &&
		!n.endsWith(".lock") &&
		!n.includes("..") &&
		!n.includes("//")
	)
}

/**
 * What `tc workflow claim` printed, read defensively. The CLI is ours, but
 * an older one does not have the command at all, and anything unexpected
 * must read as "we do not hold a claim", never as "already done".
 */
export function readClaimResult(stdout, status) {
	let parsed
	try {
		parsed = JSON.parse(String(stdout ?? "").trim().split("\n").pop())
	} catch {
		return { result: "error" }
	}
	const result = String(parsed?.result ?? "")
	const known = ["claimed", "collision", "released", "not-applicable"]
	if (!known.includes(result)) return { result: "error" }
	if (result === "collision" && status !== 3) return { result: "error" }
	return { result, workflow: String(parsed?.workflow ?? ""), ref: String(parsed?.ref ?? "") }
}
