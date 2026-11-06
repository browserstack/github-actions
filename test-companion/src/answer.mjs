/**
 * Catch the agent's own closing words out of the run's output.
 *
 * Every job announces what it concluded. Under `--json` the CLI prints one
 * event per line and `{"event":"answer","text":...}` carries the prose, for
 * every verb. What varies is whether the CLI also saves it to the result
 * file, which it does for `rca` and `verdict` alone.
 *
 * Reading the stream here means every other job can show its answer too —
 * it matters most for `fix` in preview, where the prose IS the product.
 */
import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

/**
 * How much of an unterminated line to hold before giving up on it.
 *
 * The agent runs with --yolo and picks its own shell commands, so one of them
 * printing megabytes with no newline is a thing that happens. Buffering that
 * to the end would take the runner down over output we are only scanning.
 */
export const MAX_PARTIAL_LINE = 1 << 20

/**
 * A scanner for the CLI's event stream.
 *
 * Feed it `push(chunk)` as the bytes arrive and `end` when the process
 * closes; `answer` is the last thing the agent said.
 */
export function createAnswerCapture() {
	// Chunk boundaries fall mid-character: agent prose is full of em dashes and
	// arrows, and decoding each chunk on its own splits one in half, breaks the
	// JSON and silently drops the answer — on exactly the runs with most to say.
	const decoder = new StringDecoder("utf8")
	let pending = ""
	// True while discarding the tail of a line that overran MAX_PARTIAL_LINE,
	// so its remainder is not mistaken for the start of a fresh line.
	let skipping = false
	let answer

	/** Keep this line's text if it is an answer event. Last one wins. */
	const read = (line) => {
		const t = line.trim()
		// Cheap gate first: most of this stream is not an object, and parsing
		// every log line the agent's own commands print would be wasteful.
		if (!t.startsWith("{") || !t.endsWith("}")) return
		let event
		try {
			event = JSON.parse(t)
		} catch {
			// Not an event. The stream carries whatever the run printed.
			return
		}
		if (!event || typeof event !== "object" || event.event !== "answer") return
		const text = typeof event.text === "string" ? event.text.trim() : ""
		// An empty answer must not erase a real one that came before it.
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
		/** The last line often has no newline, because the process ended. */
		end() {
			pending += decoder.end()
			if (!skipping && pending) read(pending)
			pending = ""
		},
		answer: () => answer,
		/** Bytes held for an unfinished line — for the test that pins the cap. */
		pending: () => pending.length,
	}
}

/**
 * Run a command, showing its output live AND reading it on the way past.
 *
 * stdout is piped so it can be scanned and echoed on; stdin and stderr stay
 * inherited, so a prompt or a crash reaches the log unchanged. The echo
 * happens first — someone watching a ten-minute run must not wait on our
 * parsing.
 *
 * Never rejects. Losing the answer is not a reason to lose the report too.
 */
export function runCapturingAnswer(command, args, childEnv) {
	return new Promise((resolve) => {
		const capture = createAnswerCapture()
		const child = spawn(command, args, { stdio: ["inherit", "pipe", "inherit"], env: childEnv })
		child.stdout.on("data", (chunk) => {
			process.stdout.write(chunk)
			capture.push(chunk)
		})
		child.stdout.on("error", () => {})
		// The command is missing or not executable. Null status is what
		// spawnSync gave here too, and the caller turns it into 1.
		child.on("error", () => resolve({ status: null, answer: undefined }))
		// `close`, not `exit`: exit can fire with stdout still draining, and the
		// closing message is the last thing through.
		child.on("close", (status) => {
			capture.end()
			resolve({ status, answer: capture.answer() })
		})
	})
}
