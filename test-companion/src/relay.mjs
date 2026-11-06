/**
 * The read-only GitHub relay the agent's `gh` talks to.
 *
 * The agent's gh is configured with `http_unix_socket` pointing here and a
 * placeholder token. gh then sends every request, as plain HTTP, to this
 * socket instead of to GitHub. The relay checks each one against
 * relayDecision, swaps the placeholder for the real pass on the ones that
 * may go through, and forwards them over HTTPS.
 *
 * So the agent can read what its jobs need (a failed run's logs, a pull
 * request's details) and never holds a pass that could write.
 *
 * Runs inside this Action's process, while the agent's run is going.
 */
import http from "node:http"
import https from "node:https"
import { chmodSync, rmSync } from "node:fs"
import { relayDecision } from "./sandbox-policy.mjs"

/** The most we read of a request body. GraphQL queries are small. */
const MAX_BODY = 1024 * 1024

/** Headers we never pass on: they belong to this hop, or would reveal ours. */
const HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"authorization",
	"content-length",
])

/**
 * Start the relay on `socketPath`. `token` is the pass added to allowed API
 * requests. `log` receives one line per refused request, so a run that
 * fails because the agent tried a write says so.
 *
 * Resolves to { close }.
 */
export function startRelay({ socketPath, token, log = () => {}, forward = forwardRequest }) {
	rmSync(socketPath, { force: true })
	const server = http.createServer((req, res) => {
		const chunks = []
		let size = 0
		let tooBig = false
		req.on("data", (c) => {
			size += c.length
			if (size > MAX_BODY) {
				tooBig = true
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on("end", () => {
			if (tooBig) return
			const body = Buffer.concat(chunks)
			const host = String(req.headers.host ?? "")
			const decision = relayDecision({ method: req.method, host, path: req.url, body: body.toString("utf8") })
			if (!decision.allow) {
				log(`refused ${req.method} ${host}${String(req.url).split("?")[0]}: ${decision.why}`)
				res.writeHead(403, { "content-type": "application/json" })
				res.end(JSON.stringify({ message: `Test Companion's relay refused this request: ${decision.why}` }))
				return
			}
			const headers = {}
			for (const [k, v] of Object.entries(req.headers)) {
				if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v
			}
			if (decision.auth && token) headers.authorization = `token ${token}`
			if (body.length) headers["content-length"] = String(body.length)
			forward({ host, method: req.method, path: req.url, headers, body }, res)
		})
		req.on("error", () => {})
	})
	return new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(socketPath, () => {
			// Reachable by the agent's user. The folder around it is what limits
			// who can get to it (see sandbox.mjs).
			chmodSync(socketPath, 0o666)
			resolve({
				close: () =>
					new Promise((done) => {
						server.close(() => done())
						rmSync(socketPath, { force: true })
					}),
			})
		})
	})
}

/** Send one checked request to GitHub over HTTPS and stream the answer back. */
function forwardRequest({ host, method, path, headers, body }, res) {
	const [hostname, port] = host.split(":")
	const upstream = https.request(
		{ hostname, port: port ? Number(port) : 443, method, path, headers, timeout: 120_000 },
		(answer) => {
			const out = {}
			for (const [k, v] of Object.entries(answer.headers)) {
				if (!HOP_HEADERS.has(k.toLowerCase()) || k.toLowerCase() === "content-length") out[k] = v
			}
			res.writeHead(answer.statusCode ?? 502, out)
			answer.pipe(res)
		},
	)
	upstream.on("timeout", () => upstream.destroy(new Error("timed out")))
	upstream.on("error", (e) => {
		if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" })
		res.end(JSON.stringify({ message: `Test Companion's relay could not reach ${host}: ${e.message}` }))
	})
	if (body.length) upstream.write(body)
	upstream.end()
}
