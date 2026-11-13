// Captures the agent's final `{"event":"answer"}` line from the CLI's --json stream.
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

// Cap on an unterminated line; the agent's commands can print megabytes without a newline.
export const MAX_PARTIAL_LINE = 1 << 20

/**
 * `plainErrors`: also read `Error: …` lines. Only for the CLI's stderr; on stdout the
 * agent's test output prints its own `Error:` lines (assertions, stack traces).
 */
export function createAnswerCapture({ plainErrors = true } = {}) {
	// Chunks can split a multi-byte character.
	const decoder = new StringDecoder("utf8")
	let pending = ""
	// Discarding the rest of a line that overran MAX_PARTIAL_LINE.
	let skipping = false
	let answer
	let plainError
	let structuredError

	const read = (line) => {
		const t = line.trim()
		// The CLI prints why it stopped as `Error: …` on stderr.
		const plain = plainErrors && /^Error:\s*(.+)$/.exec(t)
		if (plain) {
			plainError = plain[1]
			return
		}
		if (!t.startsWith("{") || !t.endsWith("}")) return
		let event
		try {
			event = JSON.parse(t)
		} catch {
			return
		}
		if (!event || typeof event !== "object") return
		if (event.event === "error" && typeof event.message === "string" && event.message.trim()) {
			structuredError = event.message.trim()
			return
		}
		if (event.event !== "answer") return
		const text = typeof event.text === "string" ? event.text.trim() : ""
		if (text) answer = text
	}

	return {
		push(chunk) {
			pending += typeof chunk === "string" ? chunk : decoder.write(chunk)
			let nl
			while ((nl = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, nl)
				pending = pending.slice(nl + 1)
				if (skipping) {
					skipping = false
					continue
				}
				read(line)
			}
			if (pending.length > MAX_PARTIAL_LINE) {
				pending = ""
				skipping = true
			}
		},
		end() {
			pending += decoder.end()
			if (!skipping && pending) read(pending)
			pending = ""
		},
		answer: () => answer,
		structuredError: () => structuredError,
		plainError: () => plainError,
		error: () => structuredError ?? plainError,
		pending: () => pending.length,
	}
}

/** Run a command, echoing stdout live while scanning it for the answer. Never rejects. */
export function runCapturingAnswer(command, args, childEnv) {
	return new Promise((resolve) => {
		const capture = createAnswerCapture({ plainErrors: false })
		const errors = createAnswerCapture()
		const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"], env: childEnv })
		child.stdout.on("data", (chunk) => {
			process.stdout.write(chunk)
			capture.push(chunk)
		})
		child.stderr.on("data", (chunk) => {
			process.stderr.write(chunk)
			errors.push(chunk)
		})
		child.stdout.on("error", () => {})
		child.stderr.on("error", () => {})
		child.on("error", () => resolve({ status: null, answer: undefined, error: undefined }))
		// `close`, not `exit`: stdout may still be draining at exit.
		child.on("close", (status) => {
			capture.end()
			errors.end()
			// The CLI's own structured error is the precise reason; a plain line is the fallback.
			// The CLI doesn't pass its child processes' stderr through, so the last plain
			// `Error:` line on stderr is cobra's, i.e. the CLI's own.
			const error = capture.structuredError() ?? errors.structuredError() ?? errors.plainError()
			resolve({ status, answer: capture.answer(), error })
		})
	})
}

/**
 * Hide credentials before text reaches a pull request comment. GitHub masks secrets in
 * job logs, not in comments posted through the API.
 */
export function redactSecrets(text, secrets = []) {
	if (text === undefined || text === null) return text
	let out = String(text)
	// Longest first, so a secret containing another is replaced whole.
	const known = [...new Set(secrets.map((s) => String(s ?? "").trim()).filter((s) => s.length >= 6))].sort(
		(a, b) => b.length - a.length,
	)
	for (const s of known) out = out.split(s).join("***")
	// user:password@ in any URL.
	return out.replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1***@")
}

/** redactSecrets over every string in a JSON payload about to be sent to GitHub. */
export function redactDeep(value, secrets = []) {
	if (typeof value === "string") return redactSecrets(value, secrets)
	if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets))
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)]))
	}
	return value
}

/** Values of environment variables whose names mark them as credentials. */
export function secretsFrom(env = {}) {
	return Object.entries(env)
		.filter(([k]) => /(TOKEN|ACCESS_KEY|PRIVATE_KEY|SECRET|PASSWORD)/i.test(k))
		.map(([, v]) => v)
}
