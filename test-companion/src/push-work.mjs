/**
 * Saving an approved run's work as a commit on the pull request's own branch.
 * Pure decisions; the git commands live in main.mjs.
 */

/** Must match the identity action.yml configures. */
export const BOT_EMAIL = "test-companion[bot]@users.noreply.github.com"

export const BOT_NAME = "Test Companion"

/**
 * The identity commits are made under. As the GitHub App, its bot account, so commits
 * show its name and logo; otherwise the fixed Test Companion identity.
 */
export function commitIdentity({ appSlug, appUserId } = {}) {
	const slug = String(appSlug ?? "").trim()
	const id = String(appUserId ?? "").trim()
	if (!slug || !/^\d+$/.test(id)) return { name: BOT_NAME, email: BOT_EMAIL }
	return { name: `${slug}[bot]`, email: `${id}+${slug}[bot]@users.noreply.github.com` }
}

export function authoredByUs(email, ours = []) {
	const e = String(email ?? "")
		.trim()
		.toLowerCase()
	return e === BOT_EMAIL || ours.some((o) => String(o ?? "").toLowerCase() === e && e !== "")
}

/** Jobs whose result is a report or Test Management cases, never code on the branch. */
export const NO_CODE_OUTPUT = new Set(["generate", "rca", "verdict", "validate"])

/** May this run push? Every check fails closed. */
export function shouldPushWork({ preview, sameRepo, branch, headAuthorEmail, onWantedCommit, defaultBranch, workflow, ourEmails = [] } = {}) {
	// A shell command the agent ran during preview is outside the brain's write refusal.
	if (preview) return { ok: false, why: "this is a preview run, which writes nothing" }
	// Anything such a job leaves in the checkout is a by-product, not work to save.
	if (NO_CODE_OUTPUT.has(String(workflow ?? ""))) return { ok: false, why: `${workflow} does not change code` }
	// Never push to a fork's branch with pull_request_target credentials. Unknown counts as no.
	if (sameRepo !== true) return { ok: false, why: "the change does not come from this repository" }
	if (!String(branch ?? "").trim()) return { ok: false, why: "there is no branch to push to" }
	// Pushing from the wrong tree would overwrite the change under review.
	if (onWantedCommit !== true) return { ok: false, why: "the checkout is not on the commit being reviewed" }
	// The head ref is author-controlled; never let it name the default branch.
	const base = String(defaultBranch ?? "")
		.trim()
		.toLowerCase()
	if (base && String(branch).trim().toLowerCase() === base) {
		return { ok: false, why: "that is the repository's default branch" }
	}
	// Loop guard: never push in reaction to our own commit.
	if (authoredByUs(headAuthorEmail, ourEmails)) return { ok: false, why: "this run is reacting to our own commit" }
	return { ok: true }
}

/** Paths in `git status --porcelain` output; a rename reports its destination. */
export function changedPaths(porcelain) {
	return String(porcelain ?? "")
		.split("\n")
		.filter((line) => line.trim())
		.map(stripStatus)
		.filter(Boolean)
		.map((path) => {
			const arrow = path.indexOf(" -> ")
			return arrow === -1 ? path : path.slice(arrow + 4)
		})
		.map(unquote)
}

// A caller that trims git's stdout drops the first line's leading space
// (" M path" becomes "M path"), so the status is not always two characters.
function stripStatus(line) {
	if (line[2] === " ") return line.slice(3)
	if (line[1] === " ") return line.slice(2)
	return line.slice(3)
}

// Git C-quotes some paths. `git add` stages nothing if any pathspec is missing,
// so an undecoded path loses every file. Octal escapes are bytes, decoded as UTF-8 together.
function unquote(path) {
	if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) return path
	// Walk bytes, not UTF-16 units, so raw emoji inside quotes survive.
	const src = Buffer.from(path.slice(1, -1), "utf8")
	const bytes = []
	for (let i = 0; i < src.length; i++) {
		if (src[i] !== 0x5c) {
			bytes.push(src[i])
			continue
		}
		const next = src[++i]
		if (next >= 0x30 && next <= 0x37) {
			bytes.push(parseInt(String.fromCharCode(next, src[i + 1], src[i + 2]), 8) & 0xff)
			i += 2
			continue
		}
		const simple = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7 }[String.fromCharCode(next)]
		bytes.push(simple === undefined ? next : simple)
	}
	return Buffer.from(bytes).toString("utf8")
}

// Never committed, whatever .gitignore says. Matched per path segment.
const NEVER_COMMIT = [
	/^\.env($|\.)/i,
	/^node_modules$/i,
	/^playwright-report$/i,
	/^test-results$/i,
	/^\.testcompanion$/i,
	/^blob-report$/i,
	/\.log$/i,
	// Written by BrowserStack tooling the agent runs; never part of the work.
	/^browserstack\.err$/i,
	/^\.browserstack/i,
]

/**
 * Also refuses anything under `.github/` (it controls what GitHub runs) and
 * symlinks (they can point anywhere on the runner).
 */
export function splitPushable(paths, { isSymlink = () => false } = {}) {
	const push = []
	const skip = []
	for (const path of paths ?? []) {
		const segments = String(path).split("/")
		const refused =
			segments.some((segment) => NEVER_COMMIT.some((pattern) => pattern.test(segment))) ||
			segments.some((segment) => segment.toLowerCase() === ".github") ||
			isSymlink(path)
		;(refused ? skip : push).push(path)
	}
	return { push, skip }
}

/** The pull request note about the push, including when it failed. */
export function renderPushNote({ branch, sha, files = [], skipped = [], error } = {}) {
	const list = files.map((f) => `- \`${f}\``).join("\n")
	if (error) {
		return [
			`**Could not save this work to \`${branch}\`:** ${error}`,
			"",
			"The run made these changes and they are not saved anywhere:",
			list,
		].join("\n")
	}
	const lines = [`**Saved to \`${branch}\`** as \`${String(sha ?? "").slice(0, 7)}\` — ${countOf(files)}:`, "", list]
	if (skipped.length) {
		lines.push("", `Not committed, because Test Companion never commits these: ${skipped.map((f) => `\`${f}\``).join(", ")}.`)
	}
	return lines.join("\n")
}

const countOf = (files) => (files.length === 1 ? "1 file" : `${files.length} files`)

/** Is the working tree on a different commit than the one under review? */
export function needsCheckout({ headSha, wantSha } = {}) {
	const want = String(wantSha ?? "")
		.trim()
		.toLowerCase()
	const head = String(headSha ?? "")
		.trim()
		.toLowerCase()
	if (!want || !head) return false
	return head !== want
}

/** Tri-state: undefined means unknown, which callers treat as no. */
export function isSameRepo(headRepoFullName, repo) {
	const head = String(headRepoFullName ?? "").trim()
	const ours = String(repo ?? "").trim()
	if (!head || !ours) return undefined
	return head.toLowerCase() === ours.toLowerCase()
}

/**
 * Environment that makes git push with the App's token. Empty without a
 * token, so the checkout's own credential is used.
 */
export function pushCredentialEnv(token, url) {
	const t = String(token ?? "").trim()
	const u = String(url ?? "").trim()
	if (!t || !u) return {}
	const basic = Buffer.from(`x-access-token:${t}`, "utf8").toString("base64")
	// Via the environment, not argv (visible in `ps`), and scoped to the one URL.
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `http.${u}.extraheader`,
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
	}
}

/** The push URL, built from the repository name so a rewritten `origin` is ignored. */
export function pushUrlFor(repo, server = "https://github.com") {
	const r = String(repo ?? "").trim()
	if (!/^[^/\s]+\/[^/\s]+$/.test(r)) return undefined
	return `${String(server).replace(/\/+$/, "")}/${r}.git`
}

/**
 * A near-empty environment for our git commands. They run after the agent,
 * so anything git might execute must not inherit our secrets.
 */
export function gitEnvFrom(env = {}) {
	const out = {}
	for (const k of ["HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
		if (env[k] !== undefined) out[k] = env[k]
	}
	// Pinned: the default PATH includes directories the agent can write.
	out.PATH = "/usr/bin:/bin"
	out.GIT_CONFIG_NOSYSTEM = "1"
	out.GIT_CONFIG_GLOBAL = "/dev/null"
	out.GIT_TERMINAL_PROMPT = "0"
	out.GIT_ASKPASS = ""
	out.SSH_ASKPASS = ""
	out.GIT_ATTR_NOSYSTEM = "1"
	return out
}

/**
 * The first candidate git that exists and that we cannot write, or nothing.
 * No fallback to a PATH lookup, where the agent could plant a binary.
 * Known limit: with passwordless sudo this cannot be guaranteed.
 */
export function trustedGitPath({ candidates = ["/usr/bin/git", "/bin/git"], exists, canWrite } = {}) {
	return candidates.find((p) => exists(p) && !canWrite(p))
}

/** The same rule for gh, which carries our GitHub tokens. */
export function trustedGhPath({
	candidates = ["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/bin/gh"],
	exists,
	canWrite,
} = {}) {
	return trustedGitPath({ candidates, exists, canWrite })
}

/**
 * Environment for one of our gh calls. A fresh config dir, because the shared
 * one can hold settings such as `http_unix_socket` that redirect requests.
 */
export function ghEnvFrom(source, { token, configDir }) {
	return {
		...source,
		GH_TOKEN: token,
		GH_CONFIG_DIR: configDir,
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_PROMPT_DISABLED: "1",
	}
}

/**
 * Config keys an ordinary `actions/checkout` writes. An allow list, because
 * many git config keys can make git run a program.
 */
const EXPECTED_CONFIG = [
	/^core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode|quotepath|autocrlf|safecrlf|sparsecheckout|sparsecheckoutcone)$/,
	/^remote\.[^.]+\.(url|fetch|mirror|tagopt|partialclonefilter|promisor)$/,
	/^branch\.[^.]+\.(remote|merge|rebase)$/,
	// Scoped only; a bare `http.extraheader` goes to every host.
	/^http\..+\.extraheader$/,
	/^gc\.auto$/,
	/^user\.(name|email)$/,
	/^extensions\.objectformat$/,
	/^init\.defaultbranch$/,
]

/**
 * Did HEAD move during the run? We push HEAD, so an agent commit would ride
 * along unfiltered. Unknown counts as yes.
 */
export function agentCommitted(headBefore, headNow) {
	const before = String(headBefore ?? "").trim()
	const now = String(headNow ?? "").trim()
	if (!before) return true
	return Boolean(now) && before !== now
}

// `--local`, so our own `-c` arguments are not read back as tampering.
export const CONFIG_READ_ARGS = Object.freeze(["config", "--local", "--list", "--name-only"])

/** Keys in that listing a plain checkout would not have written. */
export function unexpectedConfigKeys(listing) {
	return String(listing ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !EXPECTED_CONFIG.some((re) => re.test(l.toLowerCase())))
}

/** Arguments that stop git running anything the agent may have planted. */
export const GIT_SAFE_ARGS = Object.freeze([
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"credential.helper=",
	"-c",
	"core.askPass=",
	"-c",
	"protocol.allow=never",
	"-c",
	"protocol.https.allow=always",
	"-c",
	"http.proxy=",
	"-c",
	"core.gitProxy=",
	"-c",
	"http.sslVerify=true",
	"-c",
	"core.sshCommand=",
	"-c",
	"core.pager=cat",
	"-c",
	"diff.external=",
	"-c",
	"commit.gpgsign=false",
	"-c",
	"gpg.program=false",
	"-c",
	"core.attributesFile=/dev/null",
])

/**
 * The pull request to open for work the CLI handed back. Asked on a pull request,
 * it targets that pull request's branch, so it carries only the new change.
 */
export function handedOffPrRequest({ req, workflow, pr, prBranch, defaultBranch } = {}) {
	const onAPr = Boolean(pr && String(prBranch ?? "").trim())
	const job = String(workflow ?? "").trim() || "change"
	return {
		head: req?.branch,
		base: onAPr ? prBranch : defaultBranch || req?.base,
		title: onAPr ? `Test Companion ${job} for #${pr}` : req?.title,
		body: onAPr ? `${String(req?.body ?? "").trim()}\n\nRequested on #${pr}.`.trim() : req?.body,
		draft: true,
	}
}
