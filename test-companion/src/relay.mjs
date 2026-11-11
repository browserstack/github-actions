/**
 * Read-only GitHub relay for the agent's `gh` (via `http_unix_socket`). The
 * real token is added here to allowed requests, so the agent never holds one.
 */
import http from "node:http"
import https from "node:https"
import { chmodSync, rmSync } from "node:fs"
import { relayDecision } from "./sandbox-policy.mjs"

const MAX_BODY = 1024 * 1024

// Hop-by-hop headers, plus the agent's placeholder authorization.
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
			// Access is limited by the enclosing folder's permissions (sandbox.mjs).
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
