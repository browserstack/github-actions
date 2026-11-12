import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { createAnswerCapture, runCapturingAnswer, MAX_PARTIAL_LINE } from "../src/answer.mjs"

// One `answer` event as the CLI prints it under --json.
const said = (text) => JSON.stringify({ event: "answer", text }) + "\n"

describe("createAnswerCapture", () => {
	test("a run that said nothing has no answer", () => {
		const cap = createAnswerCapture()
		cap.end()
		assert.equal(cap.answer(), undefined)
	})

	test("it keeps what the agent said", () => {
		const cap = createAnswerCapture()
		cap.push(said("The import points one directory too high."))
		cap.end()
		assert.equal(cap.answer(), "The import points one directory too high.")
	})

	test("the LAST answer wins, because the closing message is the one that was asked for", () => {
		const cap = createAnswerCapture()
		cap.push(said("Reading the build..."))
		cap.push(said("Found it."))
		cap.push(said("Here is the fix."))
		cap.end()
		assert.equal(cap.answer(), "Here is the fix.")
	})

	test("a line split across two chunks is still read", () => {
		const line = said("split down the middle")
		const cap = createAnswerCapture()
		cap.push(line.slice(0, 12))
		cap.push(line.slice(12))
		cap.end()
		assert.equal(cap.answer(), "split down the middle")
	})

	test("a multi-byte character split across two chunks is not corrupted", () => {
		const buf = Buffer.from(said("preview — nothing was written"), "utf8")
		const cut = buf.indexOf(Buffer.from("—", "utf8")) + 1
		const cap = createAnswerCapture()
		cap.push(buf.subarray(0, cut))
		cap.push(buf.subarray(cut))
		cap.end()
		assert.equal(cap.answer(), "preview — nothing was written")
	})

	test("output that is not JSON is ignored", () => {
		const cap = createAnswerCapture()
		cap.push("Installing test-companion 1.1.10\n")
		cap.push("::group::Run\n")
		cap.push(said("the real answer"))
		cap.push("not json either\n")
		cap.end()
		assert.equal(cap.answer(), "the real answer")
	})

	test("JSON events that are not answers are ignored", () => {
		const cap = createAnswerCapture()
		cap.push(JSON.stringify({ event: "tool", name: "read_file" }) + "\n")
		cap.push(JSON.stringify({ event: "usage", credits: 6 }) + "\n")
		cap.end()
		assert.equal(cap.answer(), undefined)
	})

	test("a JSON array line is ignored rather than throwing", () => {
		const cap = createAnswerCapture()
		cap.push("[1,2,3]\n")
		cap.push('"a bare string"\n')
		cap.push("null\n")
		cap.end()
		assert.equal(cap.answer(), undefined)
	})

	test("an answer with no text does not blank an earlier one", () => {
		const cap = createAnswerCapture()
		cap.push(said("something useful"))
		cap.push(JSON.stringify({ event: "answer" }) + "\n")
		cap.push(JSON.stringify({ event: "answer", text: "   " }) + "\n")
		cap.end()
		assert.equal(cap.answer(), "something useful")
	})

	test("the final line is read even with no trailing newline", () => {
		const cap = createAnswerCapture()
		cap.push(said("first"))
		cap.push(JSON.stringify({ event: "answer", text: "last, unterminated" }))
		cap.end()
		assert.equal(cap.answer(), "last, unterminated")
	})

	test("\\r\\n line endings are handled", () => {
		const cap = createAnswerCapture()
		cap.push(JSON.stringify({ event: "answer", text: "windows" }) + "\r\n")
		cap.end()
		assert.equal(cap.answer(), "windows")
	})

	// A command the agent chose can print megabytes with no newline in it.
	test("a runaway line with no newline does not grow without bound", () => {
		const cap = createAnswerCapture()
		for (let i = 0; i < 40; i++) cap.push("x".repeat(100_000))
		assert.ok(cap.pending() <= MAX_PARTIAL_LINE, `buffered ${cap.pending()} bytes`)
		// And the stream still works afterwards.
		cap.push("\n" + said("still listening"))
		cap.end()
		assert.equal(cap.answer(), "still listening")
	})
})

describe("runCapturingAnswer", () => {
	const node = process.execPath
	// A stand-in for `tc`: prints the lines it is given, then exits.
	const fake = (script) => [node, ["-e", script]]

	test("it returns the child's exit status", async () => {
		const [cmd, args] = fake("process.exit(3)")
		const r = await runCapturingAnswer(cmd, args, process.env)
		assert.equal(r.status, 3)
	})

	test("it reads the answer off a real process's output", async () => {
		const [cmd, args] = fake(
			`process.stdout.write(JSON.stringify({event:"tool",name:"read_file"})+"\\n");` +
				`process.stdout.write(JSON.stringify({event:"answer",text:"the cause is the import"})+"\\n")`,
		)
		const r = await runCapturingAnswer(cmd, args, process.env)
		assert.equal(r.status, 0)
		assert.equal(r.answer, "the cause is the import")
	})

	// The run that failed is the one whose explanation matters most.
	test("a failing run still gives up its answer", async () => {
		const [cmd, args] = fake(
			`process.stdout.write(JSON.stringify({event:"answer",text:"tests are still red"})+"\\n");process.exit(5)`,
		)
		const r = await runCapturingAnswer(cmd, args, process.env)
		assert.equal(r.status, 5)
		assert.equal(r.answer, "tests are still red")
	})

	test("an answer larger than the pipe buffer survives being split up", async () => {
		// The child builds the payload; it is not passed in as an argument.
		const text = "— ".repeat(60_000) + "END"
		const [cmd, args] = fake(
			`const t = "— ".repeat(60000) + "END"; process.stdout.write(JSON.stringify({event:"answer",text:t})+"\\n")`,
		)
		const r = await runCapturingAnswer(cmd, args, process.env)
		assert.equal(r.answer, text)
	})

	test("the output still reaches the log on its way past", async () => {
		const [cmd, args] = fake(`process.stdout.write(JSON.stringify({event:"answer",text:"hello"})+"\\n")`)
		const seen = []
		const real = process.stdout.write.bind(process.stdout)
		process.stdout.write = (chunk, ...rest) => {
			seen.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk))
			return real(chunk, ...rest)
		}
		try {
			await runCapturingAnswer(cmd, args, process.env)
		} finally {
			process.stdout.write = real
		}
		assert.ok(seen.join("").includes('"event":"answer"'), "the child's output never reached our stdout")
	})

	// `tc` not installed.
	test("a command that does not exist resolves instead of throwing", async () => {
		const r = await runCapturingAnswer("tc-does-not-exist-anywhere", [], process.env)
		assert.equal(r.status, null)
		assert.equal(r.answer, undefined)
	})
})

describe("the CLI's reason for stopping is kept", () => {
	const node = process.execPath

	test("from an `Error:` line on stderr", async () => {
		const r = await runCapturingAnswer(node, ["-e", `process.stderr.write('Error: project "x" not found\\n'); process.exit(1)`], process.env)
		assert.equal(r.error, 'project "x" not found')
	})

	test("from an error event on stdout", async () => {
		const ev = JSON.stringify({ event: "error", fatal: true, message: "You've hit your Free credit limit." })
		const r = await runCapturingAnswer(node, ["-e", `process.stdout.write(${JSON.stringify(ev)} + "\\n"); process.exit(1)`], process.env)
		assert.equal(r.error, "You've hit your Free credit limit.")
	})

	test("stderr wins: it is the CLI's own last word", async () => {
		const ev = JSON.stringify({ event: "error", message: "api_request_failed" })
		const r = await runCapturingAnswer(
			node,
			["-e", `process.stdout.write(${JSON.stringify(ev)} + "\\n"); process.stderr.write("Error: task failed: credit limit\\n"); process.exit(1)`],
			process.env,
		)
		assert.equal(r.error, "task failed: credit limit")
	})

	test("a clean run has none", async () => {
		const r = await runCapturingAnswer(node, ["-e", "process.exit(0)"], process.env)
		assert.equal(r.error, undefined)
	})
})
