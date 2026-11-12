// Captures the agent's final `{"event":"answer"}` line from the CLI's --json stream.
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

// Cap on an unterminated line; the agent's commands can print megabytes without a newline.
export const MAX_PARTIAL_LINE = 1 << 20

export function createAnswerCapture() {
	// Chunks can split a multi-byte character.
	const decoder = new StringDecoder("utf8")
	let pending = ""
	// Discarding the rest of a line that overran MAX_PARTIAL_LINE.
	let skipping = false
	let answer
	let error

	const read = (line) => {
		const t = line.trim()
		// The CLI prints why it stopped as `Error: …` on stderr.
		const plain = /^Error:\s*(.+)$/.exec(t)
		if (plain) {
			error = plain[1]
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
			error = event.message.trim()
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
		error: () => error,
		pending: () => pending.length,
	}
}

/** Run a command, echoing stdout live while scanning it for the answer. Never rejects. */
export function runCapturingAnswer(command, args, childEnv) {
	return new Promise((resolve) => {
		const capture = createAnswerCapture()
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
			resolve({ status, answer: capture.answer(), error: errors.error() ?? capture.error() })
		})
	})
}
