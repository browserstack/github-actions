/**
 * Keeping the work.
 *
 * An approved run writes test code on a runner that is thrown away minutes
 * later. The CLI opens a pull request only for the `automate` and `fix` jobs,
 * so without this a `test-pr` run writes eight passing tests and loses all
 * eight — the very write the approval gate exists to authorise.
 *
 * It lands as a commit on the pull request's own branch, not a second pull
 * request: a reviewer who asked for tests on their change wants them there.
 *
 * Pure decisions about strings. The git commands live at the call site in
 * main.mjs, so every rule below is testable without a repository.
 */

/** Who we commit as. Must match the identity action.yml configures. */
export const BOT_EMAIL = "test-companion[bot]@users.noreply.github.com"

/** Did we write the commit this run is reacting to? */
export function authoredByUs(email) {
	return (
		String(email ?? "")
			.trim()
			.toLowerCase() === BOT_EMAIL
	)
}

/**
 * May this run push at all?
 *
 * Every arm fails closed, and each one is a different way the push could be
 * wrong rather than merely unnecessary.
 */
export function shouldPushWork({ preview, sameRepo, branch, headAuthorEmail, onWantedCommit, defaultBranch } = {}) {
	// The proposal pass. The brain refuses every write tool during preview, so
	// there should be nothing here to push — but a shell command the agent ran
	// is outside that refusal, and pushing its output would break the single
	// promise the proposal makes: nothing is written until you say go.
	if (preview) return { ok: false, why: "this is a preview run, which writes nothing" }
	// A fork's branch belongs to someone else, and `pull_request_target` hands
	// us write credentials even for fork code. Pushing there is the exact shape
	// of the attack that trigger is known for.
	// Strict `!== true`, not falsy: an unanswerable question is a no. Passing
	// a hard-coded true here was a review finding, and the same fail-open shape
	// had already appeared once in this Action on `pull_request_target`.
	if (sameRepo !== true) return { ok: false, why: "the change does not come from this repository" }
	if (!String(branch ?? "").trim()) return { ok: false, why: "there is no branch to push to" }
	// The checkout is advisory — a run continues against whatever is there, so
	// a proposal still gets built. Pushing from that tree is not advisory:
	// it would send the default branch's content to the pull request's branch
	// and clobber the change under review.
	if (onWantedCommit !== true) return { ok: false, why: "the checkout is not on the commit being reviewed" }
	// The branch name comes from the pull request's own head ref, which its
	// author controls. The default branch is the one target where a mistake is
	// not undone by closing a pull request, so it is refused by name.
	const base = String(defaultBranch ?? "")
		.trim()
		.toLowerCase()
	if (base && String(branch).trim().toLowerCase() === base) {
		return { ok: false, why: "that is the repository's default branch" }
	}
	// The loop guard. Our push makes a commit; if that commit triggers a run
	// that pushes again, the pull request fills with commits until someone
	// notices. One generation is enough.
	if (authoredByUs(headAuthorEmail)) return { ok: false, why: "this run is reacting to our own commit" }
	return { ok: true }
}

/**
 * The paths in `git status --porcelain` output.
 *
 * Deletions count: removing a test is a change worth keeping. A rename reports
 * the destination, which is where the file actually is now.
 */
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

/**
 * Drop the status code, without assuming it is exactly two characters wide.
 *
 * Porcelain writes `XY<space>path`, and X or Y may itself be a space — " M"
 * for an unstaged modification. A caller that trims git's whole stdout
 * removes that leading space from the FIRST LINE ONLY, leaving
 * `M<space>path`, and a fixed slice(3) then eats the first letter of the
 * path: `tests/pricing.spec.js` becomes `ests/pricing.spec.js` and the file
 * is never staged.
 */
function stripStatus(line) {
	if (line[2] === " ") return line.slice(3)
	if (line[1] === " ") return line.slice(2)
	return line.slice(3)
}

/**
 * Decode a porcelain path.
 *
 * Git quotes a path containing a space, a quote, a backslash or — with
 * `core.quotePath` on, which is the DEFAULT — any non-ASCII byte, using C
 * escapes for the bytes plus the usual two-character ones.
 *
 * Stripping the quotes without decoding leaves a path that does not exist,
 * and `git add` with several pathspecs aborts on the FIRST miss and stages
 * nothing — so one accented filename loses every file the run produced.
 *
 * The call site also passes `-c core.quotePath=false`. This decodes anyway,
 * so a repository that forces the setting back on cannot bring the bug back.
 *
 * Octal escapes are decoded as BYTES and then read as UTF-8 together: one
 * character is often several escapes, and decoding them singly gives
 * mojibake.
 */
function unquote(path) {
	if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) return path
	// Walk BYTES, not characters. Indexing the string by UTF-16 code unit
	// split an emoji into its two surrogate halves and Buffer.from turned each
	// half into U+FFFD, so "my 🎉 file.spec.ts" came back as a path that does
	// not exist. Reachable precisely because `core.quotePath=false` stops the
	// octal escaping but still QUOTES a path with a space — so the emoji
	// arrives raw inside quotes and lands here.
	const src = Buffer.from(path.slice(1, -1), "utf8")
	const bytes = []
	for (let i = 0; i < src.length; i++) {
		if (src[i] !== 0x5c) {
			bytes.push(src[i])
			continue
		}
		const next = src[++i]
		// Exactly three octal digits, which is what git emits.
		if (next >= 0x30 && next <= 0x37) {
			bytes.push(parseInt(String.fromCharCode(next, src[i + 1], src[i + 2]), 8) & 0xff)
			i += 2
			continue
		}
		const simple = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7 }[String.fromCharCode(next)]
		// `\"` and `\\` land in the else, and so does anything git did not escape.
		bytes.push(simple === undefined ? next : simple)
	}
	return Buffer.from(bytes).toString("utf8")
}

/**
 * What we refuse to commit, whatever the repository's .gitignore says.
 *
 * `git add` honours .gitignore already, so this is the second line of defence,
 * for a repository that happens not to ignore one of these. A pushed `.env` is
 * the worst single outcome in this feature: it publishes a credential into the
 * customer's own history, where deleting the file does not take it back.
 *
 * Matched on whole path SEGMENTS, so `src/env.js` is kept and only a real
 * `.env` is dropped.
 */
const NEVER_COMMIT = [
	/^\.env($|\.)/i,
	/^node_modules$/i,
	/^playwright-report$/i,
	/^test-results$/i,
	/^\.testcompanion$/i,
	/^blob-report$/i,
	/\.log$/i,
]

/**
 * Also refused:
 *
 * - Anything under `.github/`. That folder tells GitHub what to RUN: workflows,
 *   the repository's own reusable actions, and who must review what. GitHub
 *   already rejects workflow edits from our tokens, but not the rest, and an
 *   action file changed on a branch runs with that branch's secrets.
 * - Symlinks. A link can point anywhere on the runner, and committing one
 *   puts a path chosen by the agent into the customer's tree.
 *
 * `isSymlink` is asked per path, so this stays testable without a disk.
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

/**
 * What the pull request comment says about the push.
 *
 * A write that did not happen is said out loud, because a silent skip reads
 * as "there was nothing to write".
 *
 * The file list is not decoration: it is the only record of what an
 * autonomous agent changed in someone's branch.
 */
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

/**
 * Is the working tree sitting on the commit we think it is?
 *
 * On an `issue_comment` event GitHub checks out the DEFAULT branch. main.mjs
 * corrects that, but advisorily — it warns and carries on, so a proposal can
 * still be built from the diff when the fetch fails.
 *
 * This is the check that the advisory step actually worked. Pushing from a
 * tree that is not the reviewed commit would send the default branch's
 * content to the pull request's branch and clobber the change under review.
 *
 * Not knowing where we are is never a reason to push.
 */
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

/**
 * Is this branch in the repository we are running in?
 *
 * Tri-state, like every other access answer here: undefined means we could
 * not find out, and shouldDoPushWork treats that as a no.
 *
 * Takes the head repository's full name rather than fetching it, because
 * where it comes from depends on the trigger: a comment makes main.mjs fetch
 * the pull request, while a pull_request event already carries it on the
 * payload. Reading only the fetched object refuses every
 * pull_request-triggered push.
 */
export function isSameRepo(headRepoFullName, repo) {
	const head = String(headRepoFullName ?? "").trim()
	const ours = String(repo ?? "").trim()
	if (!head || !ours) return undefined
	return head.toLowerCase() === ours.toLowerCase()
}

/**
 * The git arguments that authenticate a push as the GitHub App.
 *
 * The App's installation token lives in GH_TOKEN, which only `gh` reads,
 * while the push is plain git authenticating with whatever
 * `actions/checkout` wrote into .git/config. Without this, a team that
 * deleted the `permissions:` block as we advise gets a 403 on every approved
 * run.
 *
 * Passed as configuration rather than baked into the remote URL: a token in
 * a URL ends up in the reflog, in error messages and in `git remote -v`.
 *
 * No token returns nothing, so the checkout's own credential is used — which
 * is correct whenever the App is not installed.
 */
export function pushCredentialEnv(token, url) {
	const t = String(token ?? "").trim()
	const u = String(url ?? "").trim()
	if (!t || !u) return {}
	const basic = Buffer.from(`x-access-token:${t}`, "utf8").toString("base64")
	// Delivered through the environment rather than `-c` on the command line.
	// argv is world-readable on the runner — any process can read the token
	// out of `ps` — while /proc/<pid>/environ is readable only by its owner.
	//
	// SCOPED to the one URL. A global `http.extraheader` attaches to whatever
	// the push resolves to, and the repository's own config can change that.
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `http.${u}.extraheader`,
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
	}
}

/**
 * Where to push, built from the trusted repository name rather than resolved
 * through the repository's own config.
 *
 * `git push origin` asks .git/config where origin is, and the agent can
 * rewrite that. Naming the URL outright means a rewritten remote is simply
 * not used.
 */
export function pushUrlFor(repo, server = "https://github.com") {
	const r = String(repo ?? "").trim()
	if (!/^[^/\s]+\/[^/\s]+$/.test(r)) return undefined
	return `${String(server).replace(/\/+$/, "")}/${r}.git`
}

/**
 * The environment our own git commands run in — deliberately almost empty.
 *
 * These run AFTER the agent, which has had --yolo write access to the working
 * tree. An agent that writes `.git/hooks/pre-commit` gets it executed by our
 * `git commit`, with whatever environment we hand it — and spawnSync with no
 * `env` inherits everything, including the App key, GH_TOKEN and the
 * customer's BrowserStack key. On `pull_request_target` the diff under test
 * is attacker-authored, so that is one prompt injection from a key leaving
 * the runner.
 *
 * Proxy settings are kept because a push has to reach the network; nothing
 * else is.
 */
export function gitEnvFrom(env = {}) {
	const out = {}
	for (const k of ["HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
		if (env[k] !== undefined) out[k] = env[k]
	}
	// PINNED, not inherited. The agent writes to the runner as the same user we
	// do, and the default PATH includes directories that user can write — a
	// planted `git` there would be handed the installation token. git shells out
	// to its own subcommands, so it still needs a PATH; this is the smallest one
	// that works and contains nothing the agent could have written to.
	out.PATH = "/usr/bin:/bin"
	// Ignore the system and user config too, so the only configuration in play
	// is what this process passes with -c.
	out.GIT_CONFIG_NOSYSTEM = "1"
	out.GIT_CONFIG_GLOBAL = "/dev/null"
	// Never ask a human, and never run a program to ask one.
	out.GIT_TERMINAL_PROMPT = "0"
	out.GIT_ASKPASS = ""
	out.SSH_ASKPASS = ""
	out.GIT_ATTR_NOSYSTEM = "1"
	return out
}

/**
 * Where the real git is, as an absolute path — or nothing, when we cannot
 * find one we are sure of.
 *
 * `spawnSync("git", ...)` resolves through PATH, and on a GitHub runner
 * several PATH directories are writable by the job's own user, which is also
 * the user the agent just ran as. A planted `git` would receive the
 * credential we pass in the environment.
 *
 * "Sure of" means it exists and WE cannot write it: a binary this process
 * could overwrite is one the agent could have overwritten.
 *
 * KNOWN LIMIT: the job's user has passwordless sudo on a GitHub-hosted
 * runner, so an agent could replace /usr/bin/git itself and pass this check.
 * Nothing inside this process can close that — the same access reaches our
 * own source, node, and the token in memory. It closes only with
 * containment.
 *
 * Deliberately no fallback to the bare name: falling back would reinstate the
 * hole on exactly the machines where it matters, so the caller skips the
 * commit instead.
 */
export function trustedGitPath({ candidates = ["/usr/bin/git", "/bin/git"], exists, canWrite } = {}) {
	return candidates.find((p) => exists(p) && !canWrite(p))
}

/**
 * Where the real gh is. The same rule as git, for the same reason, and the
 * stakes are higher: every gh call we make carries a GitHub token, and the
 * App's calls carry a token signed with the App's private key.
 *
 * The obvious hijack is `$HOME/.local/bin`. The install step puts it on PATH
 * so the CLI can be found, it comes before the system folders, and the agent
 * can write to it. A `gh` planted there would be the one a bare name finds.
 *
 * The candidates are where gh is normally installed: apt on Linux, the
 * official package and Homebrew on macOS. Same known limit as git (sudo), and
 * the same refusal to fall back to the bare name.
 */
export function trustedGhPath({
	candidates = ["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/bin/gh"],
	exists,
	canWrite,
} = {}) {
	return trustedGitPath({ candidates, exists, canWrite })
}

/**
 * The environment for one of OUR gh calls: the caller's, with the token we
 * chose and a settings folder nobody else has touched.
 *
 * The settings folder matters as much as the binary. The job-wide one is
 * shared with the agent on purpose (the CLI's own gh needs it), so the agent
 * can write a config.yml there. gh obeys that file, and one of its settings,
 * `http_unix_socket`, sends every API request, token included, to whatever
 * is listening on a local socket. A fresh empty folder per call means gh
 * runs on its defaults.
 *
 * The update check is off because it is network noise that writes a state
 * file, and prompts are off because nobody is there to answer them.
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
 * The git config an ordinary `actions/checkout` leaves behind. Anything else
 * means the repository's config was changed after the checkout.
 *
 * An ALLOW list, not a deny list. Config is where git keeps every "run this
 * program for me" hook it has — credential helpers, clean filters, textconv,
 * ssh commands, pagers — plus `insteadOf`, which rewrites any URL. Listing
 * the dangerous keys loses to the next key git adds; listing the expected
 * ones refuses anything we have never heard of.
 *
 * `.gitattributes` is deliberately absent: it only names a filter, and the
 * command a filter runs comes from `filter.<name>.*` in config.
 */
const EXPECTED_CONFIG = [
	/^core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode|quotepath|autocrlf|safecrlf|sparsecheckout|sparsecheckoutcone)$/,
	/^remote\.[^.]+\.(url|fetch|mirror|tagopt|partialclonefilter|promisor)$/,
	/^branch\.[^.]+\.(remote|merge|rebase)$/,
	// Scoped only. A bare `http.extraheader` goes to every host, so it is not
	// expected and not allowed.
	/^http\..+\.extraheader$/,
	/^gc\.auto$/,
	/^user\.(name|email)$/,
	/^extensions\.objectformat$/,
	/^init\.defaultbranch$/,
]

/**
 * How to read the repository's own config.
 *
 * `--local` is load-bearing: a bare `git config --list` also includes config
 * given on the command line with `-c`, which is where all of GIT_SAFE_ARGS
 * lives. Without it the check reads our own hardening back and calls it
 * tampering.
 *
 * Worktree config needs no separate read: turning it on requires
 * `extensions.worktreeConfig` in the local file, which is not an expected
 * key, so a repository using it is refused by this same check.
 */
/**
 * Did the agent commit something itself?
 *
 * We push `HEAD`, so anything the agent committed rides along — edits to
 * source, lockfiles or `.github/`, none of it filtered by splitPushable, and
 * a workflow-file change fails the whole push with an unreadable permissions
 * error. Our own commit is made after this check, so a HEAD that moved during
 * the run was not us.
 *
 * Fails CLOSED. Not knowing where HEAD started is not permission to push.
 */
export function agentCommitted(headBefore, headNow) {
	const before = String(headBefore ?? "").trim()
	const now = String(headNow ?? "").trim()
	if (!before) return true
	return Boolean(now) && before !== now
}

export const CONFIG_READ_ARGS = Object.freeze(["config", "--local", "--list", "--name-only"])

/**
 * The keys in that output that an ordinary
 * checkout would not have written — empty when the config is as we left it.
 *
 * Fails closed by construction: an unknown key is unexpected.
 */
export function unexpectedConfigKeys(listing) {
	return String(listing ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !EXPECTED_CONFIG.some((re) => re.test(l.toLowerCase())))
}

/**
 * Arguments that stop git running anything the agent may have planted.
 *
 * `core.hooksPath` to nowhere, because a hook is code in the repository that
 * `git commit` would run for us. fsmonitor off for the same reason — it is a
 * configurable command git will start on its own.
 */
export const GIT_SAFE_ARGS = Object.freeze([
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	// Reset the credential helper LIST. A helper is a shell command git runs
	// when a request comes back 401.
	"-c",
	"credential.helper=",
	"-c",
	"core.askPass=",
	// https only, so an ext: or a local path in a rewritten URL cannot run.
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
	// Every other key that is a way for the repository to make git run a
	// program on our behalf.
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
	// .gitattributes can name a filter command; ignore the file entirely.
	"-c",
	"core.attributesFile=/dev/null",
])
