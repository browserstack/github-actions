/**
 * Sets up and tears down the agent's locked-down user, via passwordless sudo.
 * Runs only before the agent starts or after it is stopped. Policy lives in
 * sandbox-policy.mjs.
 */
import { spawnSync } from "node:child_process"
import { closeSync, constants, copyFileSync, existsSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import { AGENT_USER, LAUNCHER_SOURCE, sandboxLayout } from "./sandbox-policy.mjs"
import { BOT_EMAIL, BOT_NAME } from "./push-work.mjs"

const SUDO = "/usr/bin/sudo"

function sudo(args, input) {
	const r = spawnSync(SUDO, ["-n", ...args], { encoding: "utf8", input, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } })
	return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.error?.message ?? "").trim() }
}

export function canIsolate() {
	if (process.platform !== "linux") return { ok: false, why: "this is not a Linux runner" }
	if (!existsSync(SUDO)) return { ok: false, why: "sudo is not installed" }
	const s = sudo(["true"])
	if (!s.ok) return { ok: false, why: "this job cannot use sudo without a password" }
	for (const tool of ["/usr/bin/setpriv", "/usr/bin/setfacl"]) {
		if (!existsSync(tool)) return { ok: false, why: `${tool} is not installed` }
	}
	return { ok: true }
}

function writeAs(path, content, owner, mode) {
	const w = sudo(["tee", path], content)
	if (!w.ok) throw new Error(`could not write ${path}: ${w.err}`)
	must(sudo(["chown", owner, path]), `chown ${path}`)
	must(sudo(["chmod", mode, path]), `chmod ${path}`)
}

function must(r, what) {
	if (!r.ok) throw new Error(`${what} failed: ${r.err || "no detail"}`)
	return r
}

export function prepareSandbox({ repoDir, tcPath, identity = { name: BOT_NAME, email: BOT_EMAIL } }) {
	const layout = sandboxLayout()
	const me = userInfo().username

	// May already exist on a reused self-hosted runner.
	if (!sudo(["id", "-u", AGENT_USER]).ok) {
		must(sudo(["useradd", "--create-home", "--shell", "/bin/bash", AGENT_USER]), "creating the agent user")
	}
	const rules = sudo(["-l", "-U", AGENT_USER])
	if (/may run the following commands/i.test(rules.out)) {
		throw new Error(`${AGENT_USER} has sudo rights on this machine, so it would not be locked down`)
	}

	sudo(["pkill", "-KILL", "-u", AGENT_USER])
	sudo(["umount", layout.work])

	must(sudo(["rm", "-rf", layout.root]), "clearing the agent's folder")
	must(sudo(["mkdir", "-p", layout.work, layout.in, layout.out, layout.relay, layout.tmp]), "creating the agent's folders")
	must(sudo(["chmod", "755", layout.root, layout.work]), "chmod root")
	must(sudo(["chown", `${me}:${me}`, layout.in]), "chown in")
	must(sudo(["chmod", "755", layout.in]), "chmod in")
	must(sudo(["chown", `${AGENT_USER}:${AGENT_USER}`, layout.out, layout.tmp]), "chown out")
	must(sudo(["chmod", "755", layout.out]), "chmod out")
	must(sudo(["chmod", "700", layout.tmp]), "chmod tmp")
	// Only the agent's group can reach the relay socket inside.
	must(sudo(["chown", `${me}:${AGENT_USER}`, layout.relay]), "chown relay")
	must(sudo(["chmod", "750", layout.relay]), "chmod relay")

	// ACLs share the checkout without changing ownership; the bind mount means
	// the agent never needs access to the runner's home.
	must(
		sudo(["setfacl", "-R", "-m", `u:${AGENT_USER}:rwX,d:u:${AGENT_USER}:rwX,u:${me}:rwX,d:u:${me}:rwX,m::rwx,d:m::rwx`, repoDir]),
		"sharing the checkout",
	)
	must(sudo(["mount", "--bind", repoDir, layout.work]), "mounting the checkout")

	// The agent's own copy of the CLI; we never run this copy ourselves.
	must(sudo(["mkdir", "-p", layout.bin, layout.ghConfig]), "creating the agent's home folders")
	must(sudo(["cp", tcPath, `${layout.bin}/tc`]), "copying the CLI")
	must(sudo(["chmod", "755", `${layout.bin}/tc`]), "chmod tc")

	// The token is a placeholder; the relay swaps in the real one.
	writeAs(`${layout.ghConfig}/config.yml`, `http_unix_socket: ${layout.socket}\nprompt: disabled\n`, `${AGENT_USER}:${AGENT_USER}`, "600")
	writeAs(
		`${layout.ghConfig}/hosts.yml`,
		`github.com:\n    oauth_token: relayed-by-test-companion\n    user: ${AGENT_USER}\n    git_protocol: https\n`,
		`${AGENT_USER}:${AGENT_USER}`,
		"600",
	)
	// safe.directory: git refuses a repository owned by another user.
	writeAs(
		`${layout.home}/.gitconfig`,
		`[safe]\n\tdirectory = ${layout.work}\n[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n`,
		`${AGENT_USER}:${AGENT_USER}`,
		"644",
	)
	must(sudo(["chown", "-R", `${AGENT_USER}:${AGENT_USER}`, `${layout.home}/.local`, `${layout.home}/.config`]), "chown home")
	writeFileSync(`${layout.in}/launch.mjs`, LAUNCHER_SOURCE, { mode: 0o644 })
	return { ...layout, launcher: `${layout.in}/launch.mjs` }
}

/** The env goes in a 600 file, not on sudo's (logged) command line. */
export function writeAgentEnv(layout, env, name = "env.json") {
	const path = `${layout.tmp}/${name}`
	writeAs(path, JSON.stringify(env), `${AGENT_USER}:${AGENT_USER}`, "600")
	return path
}

/** Call before reading the agent's output, so no leftover process can still change it. */
export function stopSandbox(layout) {
	sudo(["pkill", "-KILL", "-u", AGENT_USER])
	const u = sudo(["umount", layout.work])
	return { unmounted: u.ok }
}

export function handToAgent(layout, from, name) {
	const to = `${layout.in}/${name}`
	copyFileSync(from, to)
	return to
}

export function writeForAgent(layout, name, content) {
	const to = `${layout.in}/${name}`
	writeFileSync(to, content)
	return to
}

/**
 * Reads a file from the agent's folder. O_NOFOLLOW: the agent could plant a
 * symlink to one of our files and get its contents into the PR comment.
 */
export function readAgentFile(path, maxBytes = 2 * 1024 * 1024) {
	let fd
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		const st = fstatSync(fd)
		if (!st.isFile() || st.size > maxBytes) return undefined
		const buf = Buffer.alloc(st.size)
		let got = 0
		while (got < st.size) {
			const n = readSync(fd, buf, got, st.size - got, got)
			if (n === 0) break
			got += n
		}
		return buf.subarray(0, got).toString("utf8")
	} catch {
		return undefined
	} finally {
		if (fd !== undefined) closeSync(fd)
	}
}
