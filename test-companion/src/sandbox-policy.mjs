/**
 * Pure rules for running the agent as a separate user without sudo. As the
 * runner's own user it could read our secrets from /proc/<pid>/environ, or via
 * sudo from the runner worker's memory.
 */

export const AGENT_USER = "tc-agent"

/**
 * Outside the runner's home, which holds gh's config and runner credentials.
 * `in` is ours (agent reads), `out` is the agent's (we read carefully).
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

/** GH_CONFIG_DIR points at the agent's relay-only gh config, never ours. */
export function agentEnvFrom(childEnv, layout, extra = {}) {
	const env = { ...childEnv }
	env.HOME = layout.home
	env.USER = AGENT_USER
	env.LOGNAME = AGENT_USER
	env.GH_CONFIG_DIR = layout.ghConfig
	env.RUNNER_TEMP = layout.tmp
	env.TMPDIR = layout.tmp
	// The rest of PATH is kept for the customer's toolchain.
	env.PATH = [layout.bin, ...String(childEnv.PATH ?? "/usr/bin:/bin").split(":").filter((p) => p && p !== layout.bin)].join(":")
	env.GH_NO_UPDATE_NOTIFIER = "1"
	env.GH_PROMPT_DISABLED = "1"
	return { ...env, ...extra }
}

/**
 * The environment is passed via `envFile`, not this command line, because
 * sudo logs its command lines.
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
 * Reads only; the Action does every write itself. GraphQL POSTs pass only for
 * queries. Other hosts get GET without the token (log and artifact downloads
 * redirect to signed storage URLs).
 */
export function relayDecision({ method, host, path, body }) {
	const m = String(method ?? "").toUpperCase()
	const h = String(host ?? "")
		.toLowerCase()
		.replace(/:443$/, "")
	const p = String(path ?? "")
	const api = h === "api.github.com"
	if (!p.startsWith("/")) return { allow: false, why: "a path must start with /" }
	// A GET to /graphql would carry its query in the URL, past the body check.
	if (api && /^\/graphql(\/|\?|$)/.test(p) && m !== "POST") return { allow: false, why: "GraphQL is only passed on as a checked POST" }
	if (api && (m === "GET" || m === "HEAD")) return { allow: true, auth: true }
	if (api && m === "POST" && (p === "/graphql" || p.startsWith("/graphql?"))) {
		return isReadOnlyGraphql(body)
			? { allow: true, auth: true }
			: { allow: false, why: "only GraphQL queries are passed on, never mutations" }
	}
	if (!api && h && (m === "GET" || m === "HEAD")) {
		if (h === "github.com" || h.endsWith(".github.com")) {
			return { allow: false, why: `${h} is not passed on` }
		}
		return { allow: true, auth: false }
	}
	return { allow: false, why: `${m} to ${h || "an unknown host"} is not passed on` }
}

/**
 * Strings and comments are lexed in a single pass: separate passes let a `"`
 * inside a `#` comment hide a mutation. Anything unparseable counts as a write.
 */
export function isReadOnlyGraphql(body) {
	let doc
	try {
		const parsed = JSON.parse(String(body ?? ""))
		if (Array.isArray(parsed)) return parsed.length > 0 && parsed.every((one) => isReadOnlyGraphql(JSON.stringify(one)))
		doc = parsed?.query
	} catch {
		return false
	}
	if (typeof doc !== "string" || doc.trim() === "") return false
	const tokens = graphqlTokens(doc)
	if (!tokens) return false

	if (tokens.some((t) => t === "mutation" || t === "subscription")) return false

	let depth = 0
	let expectDefinition = true
	for (const t of tokens) {
		if (t === "{") {
			if (depth === 0 && expectDefinition) expectDefinition = false
			depth++
			continue
		}
		if (t === "}") {
			depth--
			if (depth < 0) return false
			if (depth === 0) expectDefinition = true
			continue
		}
		if (depth === 0 && expectDefinition) {
			if (t !== "query" && t !== "fragment") return false
			expectDefinition = false
		}
	}
	return depth === 0
}

/** Names and braces only; undefined if malformed (e.g. an unclosed string). */
function graphqlTokens(doc) {
	const out = []
	let i = 0
	const n = doc.length
	while (i < n) {
		const c = doc[i]
		if (c === "#") {
			while (i < n && doc[i] !== "\n" && doc[i] !== "\r") i++
			continue
		}
		if (c === '"') {
			if (doc.startsWith('"""', i)) {
				i += 3
				for (;;) {
					if (i >= n) return undefined
					if (doc.startsWith('\\"""', i)) {
						i += 4
						continue
					}
					if (doc.startsWith('"""', i)) {
						i += 3
						break
					}
					i++
				}
				continue
			}
			i++
			for (;;) {
				if (i >= n) return undefined
				const d = doc[i]
				if (d === "\n" || d === "\r") return undefined
				if (d === "\\") {
					i += 2
					continue
				}
				i++
				if (d === '"') break
			}
			continue
		}
		if (c === "{" || c === "}") {
			out.push(c)
			i++
			continue
		}
		if (/[A-Za-z_]/.test(c)) {
			let j = i + 1
			while (j < n && /[A-Za-z0-9_]/.test(doc[j])) j++
			out.push(doc.slice(i, j))
			i = j
			continue
		}
		i++
	}
	return out
}

/** Validates the agent-written PR request; none of it is trusted. */
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

/** Anything unexpected (e.g. an older CLI) reads as "no claim held". */
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
