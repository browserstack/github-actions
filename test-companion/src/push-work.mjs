/**
 * Keeping the work — STM-5434 FR-43.
 *
 * An approved run writes test code on the runner, and the runner is thrown
 * away minutes later. Until this module existed there was no path by which any
 * of it survived: the CLI opens a pull request only for the `automate` and
 * `fix` jobs, so a `test-pr` run wrote eight passing tests and lost all eight.
 * The approval gate exists to authorise exactly that write, which made the
 * missing half the one thing the whole conversation was for.
 *
 * Where the work goes is already settled by FR-42, in access.mjs: "Tests go in
 * the pull request's own repository by default." So a commit on the pull
 * request's own branch, not a second pull request — a reviewer who asked for
 * tests on their change wants them on their change.
 *
 * Everything here is a pure decision about strings. The git commands live at
 * the call site in main.mjs, so every rule below is testable without a
 * repository.
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
 * for an unstaged modification. A caller that trims git's whole stdout removes
 * that leading space from the FIRST LINE ONLY, leaving `M<space>path`. A fixed
 * slice(3) then eats the first letter of the path, which is how run
 * 40845669513 tried to add `ests/pricing.spec.js` and lost ten passing tests.
 *
 * The caller no longer trims, and this no longer assumes the width, because
 * the version that assumed it passed every unit test and still failed live.
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
 * `core.quotePath` on, which is the DEFAULT — any non-ASCII byte. Inside the
 * quotes it uses C escapes: `\\303\\251` for the two bytes of "é", plus the
 * usual `\\"`, `\\\\`, `\\n`, `\\t`.
 *
 * Stripping the quotes without decoding leaves a path that does not exist.
 * `git add` with several pathspecs aborts on the FIRST miss and stages
 * nothing, so a single accented filename lost every file an approved run had
 * written — exactly what this module exists to prevent.
 *
 * The call site also passes `-c core.quotePath=false`, which stops the octal
 * escaping at source. This decodes it regardless, so a repository that forces
 * the setting back on cannot bring the bug back.
 *
 * Octal escapes are decoded as BYTES and then read as UTF-8 together, because
 * one character is often several escapes and decoding them one at a time
 * produces mojibake.
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

export function splitPushable(paths) {
	const push = []
	const skip = []
	for (const path of paths ?? []) {
		const segments = String(path).split("/")
		const refused = segments.some((segment) => NEVER_COMMIT.some((pattern) => pattern.test(segment)))
		;(refused ? skip : push).push(path)
	}
	return { push, skip }
}

/**
 * What the pull request comment says about the push — FR-42's rule applied to
 * this step: a write that did not happen is said out loud, because a silent
 * skip reads as "there was nothing to write".
 *
 * The file list is not decoration. This is the only record of what an
 * autonomous agent changed in someone's branch, and a reviewer who cannot see
 * it has to diff the branch to find out.
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
 * On an `issue_comment` event GitHub checks out the DEFAULT branch, because the
 * payload names no ref. main.mjs already corrects that where it resolves the
 * comment's issue number into a head sha: it fetches that commit and detaches
 * onto it. But that step is ADVISORY — it warns and carries on, so a proposal
 * can still be built from the diff when the fetch fails.
 *
 * Which makes this the check that the advisory step actually worked. Pushing
 * from a tree that is not the reviewed commit would send the default branch's
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
 * Tri-state, like every other access answer here: undefined means we could not
 * find out, and shouldDoPushWork treats that as a no.
 *
 * Takes the head repository's full name rather than fetching it, because where
 * it comes from depends on the trigger. A comment names an issue, so main.mjs
 * fetches the pull request to resolve a head sha; a pull_request event already
 * carries it on the payload and nothing is fetched. Reading only the fetched
 * object refused every pull_request-triggered push (run 40857884973).
 */
export function isSameRepo(headRepoFullName, repo) {
	const head = String(headRepoFullName ?? "").trim()
	const ours = String(repo ?? "").trim()
	if (!head || !ours) return undefined
	return head.toLowerCase() === ours.toLowerCase()
}

/**
 * The git arguments that authenticate a push as the GitHub App — FR-4.
 *
 * The App's installation token lives in GH_TOKEN, which only `gh` reads. The
 * push is plain git, authenticating with whatever `actions/checkout` wrote
 * into .git/config — the workflow token. So a team that followed our own
 * advice and deleted the `permissions:` block, as action.yml and the starter
 * both suggest, got a 403 on every approved run.
 *
 * Passed with `-c` rather than baked into the remote URL: a token in a URL
 * ends up in the reflog, in error messages and in `git remote -v`. This way
 * it lives only in this one process's arguments, and appInstallationToken has
 * already masked it in the log.
 *
 * No token returns nothing, so the checkout's own credential is used — which
 * is correct whenever the App is not installed.
 */
export function pushCredentialArgs(token) {
	const t = String(token ?? "").trim()
	if (!t) return []
	const basic = Buffer.from(`x-access-token:${t}`, "utf8").toString("base64")
	return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`]
}

/**
 * The environment our own git commands run in — deliberately almost empty.
 *
 * These run AFTER the agent, which has had --yolo write access to the working
 * tree. An agent that writes `.git/hooks/pre-commit` gets it executed by our
 * `git commit`, with whatever environment we hand it — and that environment
 * held TC_ACTION_APP_PRIVATE_KEY, GH_TOKEN and the customer's BrowserStack
 * key, because spawnSync with no `env` inherits everything.
 *
 * On `pull_request_target` the diff under test is attacker-authored, so that
 * is a prompt-injection away from a key leaving the runner.
 *
 * childEnvFor already does this for the AGENT's subprocess. This is the same
 * reasoning applied to the commands that run after it. Proxy settings are kept
 * because a push has to reach the network; nothing else is.
 */
export function gitEnvFrom(env = {}) {
	const out = {}
	for (const k of ["PATH", "HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
		if (env[k] !== undefined) out[k] = env[k]
	}
	return out
}

/**
 * Arguments that stop git running anything the agent may have planted.
 *
 * `core.hooksPath` to nowhere, because a hook is code in the repository that
 * `git commit` would run for us. fsmonitor off for the same reason — it is a
 * configurable command git will start on its own.
 */
export const GIT_SAFE_ARGS = Object.freeze(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"])
