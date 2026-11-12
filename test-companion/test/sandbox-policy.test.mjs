import { test, describe } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { rmSync } from "node:fs"
import {
	AGENT_USER,
	sandboxLayout,
	agentEnvFrom,
	asAgentCommand,
	relayDecision,
	isReadOnlyGraphql,
	checkPrHandoff,
	isPlainBranchName,
	readClaimResult,
} from "../src/sandbox-policy.mjs"
import { startRelay } from "../src/relay.mjs"

const layout = sandboxLayout()
const q = (query) => JSON.stringify({ query, variables: {} })

// The agent's environment points at its own folders, never ours.
describe("the agent's environment", () => {
	const ours = {
		PATH: "/home/runner/.local/bin:/opt/hostedtoolcache/node/22/x64/bin:/usr/bin",
		HOME: "/home/runner",
		GH_CONFIG_DIR: "/home/runner/work/_temp/tc-gh-config",
		RUNNER_TEMP: "/home/runner/work/_temp",
		BROWSERSTACK_USERNAME: "u",
	}

	test("gh's config, home and temp are the agent's", () => {
		const got = agentEnvFrom(ours, layout)
		assert.equal(got.GH_CONFIG_DIR, layout.ghConfig)
		assert.equal(got.HOME, layout.home)
		assert.equal(got.RUNNER_TEMP, layout.tmp)
		assert.equal(got.TMPDIR, layout.tmp)
		assert.equal(got.USER, AGENT_USER)
	})

	test("its own CLI comes first, and the customer's toolchain stays on PATH", () => {
		const path = agentEnvFrom(ours, layout).PATH.split(":")
		assert.equal(path[0], layout.bin)
		assert.ok(path.includes("/opt/hostedtoolcache/node/22/x64/bin"))
	})

	test("what the allowlist kept is still there", () => {
		assert.equal(agentEnvFrom(ours, layout).BROWSERSTACK_USERNAME, "u")
	})

	test("extra settings for this run are added", () => {
		assert.equal(agentEnvFrom(ours, layout, { TC_WORKFLOW_PR_HANDOFF: "/x" }).TC_WORKFLOW_PR_HANDOFF, "/x")
	})
})

// sudo logs the command line it runs, and on a self-hosted runner that log outlives the job.
describe("the command that starts the agent", () => {
	const cmd = asAgentCommand({
		node: "/usr/local/bin/node",
		launcher: `${layout.in}/launch.mjs`,
		envFile: `${layout.tmp}/env.json`,
		cwd: layout.work,
		command: `${layout.bin}/tc`,
		args: ["workflow", "run", "--event", "pr_comment"],
	})

	test("switches to the agent user and drops every other group", () => {
		assert.equal(cmd.command, "/usr/bin/sudo")
		assert.ok(cmd.args.includes(`--reuid=${AGENT_USER}`))
		assert.ok(cmd.args.includes(`--regid=${AGENT_USER}`))
		assert.ok(cmd.args.includes("--init-groups"))
	})

	test("starts from an empty environment and carries none on its command line", () => {
		assert.ok(cmd.args.includes("--reset-env"))
		assert.ok(cmd.args.includes("-i"))
		const assignments = cmd.args.filter((a) => /^[A-Z_]+=/.test(a))
		assert.deepEqual(assignments, ["PATH=/usr/bin:/bin"])
	})

	test("works in the mounted checkout", () => {
		const i = cmd.args.indexOf("-C")
		assert.equal(cmd.args[i + 1], layout.work)
	})
})

describe("the relay passes on reads only", () => {
	test("API reads are passed on, with the pass", () => {
		assert.deepEqual(relayDecision({ method: "GET", host: "api.github.com", path: "/repos/o/r/actions/runs/1/logs" }), {
			allow: true,
			auth: true,
		})
		assert.equal(relayDecision({ method: "HEAD", host: "api.github.com:443", path: "/repos/o/r" }).allow, true)
	})

	test("API writes are refused", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			assert.equal(relayDecision({ method, host: "api.github.com", path: "/repos/o/r/pulls" }).allow, false, method)
		}
	})

	test("a GraphQL query is passed on, a mutation is not", () => {
		const read = q("query PullRequestByNumber($owner: String!) { repository(owner: $owner) { pullRequest(number: 1) { title } } }")
		assert.equal(relayDecision({ method: "POST", host: "api.github.com", path: "/graphql", body: read }).allow, true)
		const write = q('mutation { addComment(input: {subjectId: "x", body: "hi"}) { clientMutationId } }')
		assert.equal(relayDecision({ method: "POST", host: "api.github.com", path: "/graphql", body: write }).allow, false)
	})

	test("downloads from storage hosts go through, without the pass", () => {
		assert.deepEqual(
			relayDecision({ method: "GET", host: "productionresultssa1.blob.core.windows.net", path: "/actions-results/x?sig=y" }),
			{ allow: true, auth: false },
		)
	})

	test("github.com itself, and writes anywhere else, are refused", () => {
		assert.equal(relayDecision({ method: "GET", host: "github.com", path: "/o/r" }).allow, false)
		assert.equal(relayDecision({ method: "GET", host: "uploads.github.com", path: "/x" }).allow, false)
		assert.equal(relayDecision({ method: "POST", host: "example.com", path: "/x" }).allow, false)
	})

	test("a request with no path or host is refused", () => {
		assert.equal(relayDecision({ method: "GET", host: "api.github.com", path: "http://evil/x" }).allow, false)
		assert.equal(relayDecision({ method: "GET", host: "", path: "/x" }).allow, false)
	})
})

describe("telling a GraphQL read from a write", () => {
	test("plain and named queries, with variables, fragments and directives, are reads", () => {
		for (const doc of [
			"{ viewer { login } }",
			"query { viewer { login } }",
			"query Q($n: Int! = 3) @cached { repository(owner: \"o\", name: \"r\") { pullRequest(number: $n) { ...F } } }",
			"fragment F on PullRequest { title } query Q { viewer { login } }",
			"# a mutation in a comment\nquery { viewer { login } }",
			'query { search(query: "mutation subscription") { issueCount } }',
		]) {
			assert.equal(isReadOnlyGraphql(q(doc)), true, doc)
		}
	})

	test("a mutation or subscription anywhere is a write", () => {
		for (const doc of [
			"mutation { x }",
			"query A { viewer { login } } mutation B { x }",
			"subscription { x }",
			"  mutation\n{ x }",
		]) {
			assert.equal(isReadOnlyGraphql(q(doc)), false, doc)
		}
	})

	test("anything we cannot read cleanly counts as a write", () => {
		for (const body of ["", "not json", JSON.stringify({}), q(""), q("{ unbalanced"), q("} {"), q("evil { x }")]) {
			assert.equal(isReadOnlyGraphql(body), false, body)
		}
	})

	test("a quote inside a comment cannot hide a mutation", () => {
		const bypass = JSON.stringify({
			query: 'query Q { viewer { login } } # "\nmutation M { addComment(input: {}) { clientMutationId } } # "',
			operationName: "M",
		})
		assert.equal(isReadOnlyGraphql(bypass), false)
		assert.equal(relayDecision({ method: "POST", host: "api.github.com", path: "/graphql", body: bypass }).allow, false)
		assert.equal(isReadOnlyGraphql(q('query Q { a } # "\rmutation M { b }')), false, "a carriage return ends a comment too")
	})

	test("strings and comments are read the way GraphQL reads them", () => {
		assert.equal(isReadOnlyGraphql(q('query Q { a(x: """ # not a comment """) }')), true)
		assert.equal(isReadOnlyGraphql(q('query Q { a(x: """mutation""") }')), true, "a keyword inside a block string is text")
		assert.equal(isReadOnlyGraphql(q('query Q { a(x: "he said \\"hi\\" # ") }')), true, "an escaped quote does not end a string")
		assert.equal(isReadOnlyGraphql(q('query Q { a(x: "open) }')), false, "a string that never closes")
		assert.equal(isReadOnlyGraphql(q('query Q { a(x: "one\ntwo") }')), false, "a plain string cannot span lines")
		assert.equal(isReadOnlyGraphql(q('query Q { a(x: """never closes) }')), false)
	})

	test("the mutation keyword is refused at any depth, as a second check", () => {
		assert.equal(isReadOnlyGraphql(q("query Q { a { mutation } }")), false)
	})

	test("GraphQL is never passed on as a GET, whose query would skip the check", () => {
		assert.equal(relayDecision({ method: "GET", host: "api.github.com", path: "/graphql?query=mutation%7Bx%7D" }).allow, false)
		assert.equal(relayDecision({ method: "HEAD", host: "api.github.com", path: "/graphql" }).allow, false)
		assert.equal(relayDecision({ method: "GET", host: "api.github.com", path: "/graphql-not-really" }).allow, true)
	})

	test("a batch is a read only if every request in it is", () => {
		assert.equal(isReadOnlyGraphql(JSON.stringify([{ query: "{ a }" }, { query: "{ b }" }])), true)
		assert.equal(isReadOnlyGraphql(JSON.stringify([{ query: "{ a }" }, { query: "mutation { b }" }])), false)
		assert.equal(isReadOnlyGraphql(JSON.stringify([])), false)
	})
})

// The agent's run writes this file and the agent can change it, so nothing in it is taken on trust.
describe("a pull request handed back by the CLI", () => {
	const sha = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"
	const good = { workflow: "fix", sha, branch: `tc/fix/${sha}`, base: "main", title: "tc fix", body: "b" }

	test("the CLI's own request is accepted", () => {
		assert.deepEqual(checkPrHandoff(JSON.stringify(good), { sha }), good)
	})

	test("a branch other than the job's own is refused", () => {
		const got = checkPrHandoff(JSON.stringify({ ...good, branch: "main" }), { sha })
		assert.match(got.error, /not the one this job uses/)
	})

	test("a request for another commit is refused", () => {
		assert.match(checkPrHandoff(JSON.stringify(good), { sha: "f".repeat(40) }).error, /different commit/)
	})

	test("only automate and fix open pull requests", () => {
		assert.match(checkPrHandoff(JSON.stringify({ ...good, workflow: "generate", branch: `tc/generate/${sha}` })).error, /no pull request/)
	})

	test("a base that is not a plain branch name is refused", () => {
		for (const base of ["", "-x", "a..b", "refs/../x", "main.lock", "has space"]) {
			assert.ok(checkPrHandoff(JSON.stringify({ ...good, base }), { sha }).error, base)
		}
	})

	test("an unreadable file is refused", () => {
		assert.ok(checkPrHandoff("{nope", { sha }).error)
		assert.ok(checkPrHandoff("null", { sha }).error)
	})

	test("the title and body are capped", () => {
		const got = checkPrHandoff(JSON.stringify({ ...good, title: "t".repeat(1000), body: "b".repeat(100000) }), { sha })
		assert.equal(got.title.length, 256)
		assert.equal(got.body.length, 60000)
	})

	test("plain branch names", () => {
		assert.equal(isPlainBranchName("release/1.2"), true)
		assert.equal(isPlainBranchName("feature//x"), false)
	})
})

describe("reading what `tc workflow claim` printed", () => {
	test("a held marker", () => {
		assert.deepEqual(readClaimResult('{"result":"claimed","workflow":"fix","ref":"refs/tc/x"}', 0), {
			result: "claimed",
			workflow: "fix",
			ref: "refs/tc/x",
		})
	})

	test("already done needs the matching exit code", () => {
		assert.equal(readClaimResult('{"result":"collision","workflow":"fix","ref":"r"}', 3).result, "collision")
		// Anything unexpected must never read as "already done".
		assert.equal(readClaimResult('{"result":"collision"}', 0).result, "error")
	})

	test("an older CLI, or noise, reads as an error", () => {
		assert.equal(readClaimResult("Usage: tc workflow ...", 0).result, "error")
		assert.equal(readClaimResult('{"result":"weird"}', 0).result, "error")
	})

	test("the JSON line is the last line", () => {
		assert.equal(readClaimResult('warning: x\n{"result":"not-applicable","workflow":"","ref":""}', 0).result, "not-applicable")
	})
})

describe("the relay, over its socket", () => {
	const socketPath = `/tmp/tc-relay-test-${process.pid}.sock`
	const send = (method, path, body, host = "api.github.com") =>
		new Promise((resolve, reject) => {
			const req = http.request(
				{ socketPath, method, path, headers: { host, authorization: "token placeholder", "content-type": "application/json" } },
				(res) => {
					let data = ""
					res.on("data", (c) => (data += c))
					res.on("end", () => resolve({ status: res.statusCode, data }))
				},
			)
			req.on("error", reject)
			if (body) req.write(body)
			req.end()
		})

	test("forwards reads with the real pass, refuses writes, and says why", async () => {
		const forwarded = []
		const refused = []
		const relay = await startRelay({
			socketPath,
			token: "real-pass",
			log: (l) => refused.push(l),
			forward: (req, res) => {
				forwarded.push(req)
				res.writeHead(200, { "content-type": "application/json" })
				res.end("{}")
			},
		})
		try {
			const ok = await send("GET", "/repos/o/r/pulls/1")
			assert.equal(ok.status, 200)
			assert.equal(forwarded[0].headers.authorization, "token real-pass")
			assert.equal(forwarded[0].host, "api.github.com")

			const blocked = await send("POST", "/repos/o/r/issues/1/comments", '{"body":"x"}')
			assert.equal(blocked.status, 403)
			assert.match(blocked.data, /refused/)
			assert.equal(forwarded.length, 1)
			assert.equal(refused.length, 1)

			const storage = await send("GET", "/logs.zip?sig=1", undefined, "results.blob.core.windows.net")
			assert.equal(storage.status, 200)
			assert.equal(forwarded[1].headers.authorization, undefined, "no pass to other hosts")
		} finally {
			await relay.close()
			rmSync(socketPath, { force: true })
		}
	})
})
