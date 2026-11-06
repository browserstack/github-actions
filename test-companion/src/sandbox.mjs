/**
 * Setting up, and taking down, the locked-down user the agent runs as.
 *
 * The rules and the reasons are in sandbox-policy.mjs. This file is the part
 * that acts on the machine, through `sudo`, which a GitHub-hosted runner gives
 * the job without a password. A runner without it cannot isolate the agent,
 * and canIsolate says so.
 *
 * Every command here runs BEFORE the agent starts or AFTER it has been
 * stopped, and finds its programs by absolute path.
 */
import { spawnSync } from "node:child_process"
import { closeSync, constants, copyFileSync, existsSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import { AGENT_USER, LAUNCHER_SOURCE, sandboxLayout } from "./sandbox-policy.mjs"

const SUDO = "/usr/bin/sudo"

function sudo(args, input) {
	const r = spawnSync(SUDO, ["-n", ...args], { encoding: "utf8", input, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } })
	return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.error?.message ?? "").trim() }
}

/**
 * Whether this machine can run the agent as a separate user, and if not, why.
 * Needs Linux, password-free sudo, and the two tools we use (setpriv to
 * switch user, setfacl to share the checkout).
 */
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

/** Write a file as root with the given owner and mode. */
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

/**
 * Create the agent's user and folders, share the checkout with it, give it
 * its own copy of the CLI and a gh that talks only to the relay.
 *
 * `repoDir` is the checked-out repository. `tcPath` is the CLI we installed.
 * Throws with a plain reason if any step fails; the caller decides whether
 * to stop or carry on unisolated.
 */
export function prepareSandbox({ repoDir, tcPath }) {
	const layout = sandboxLayout()
	const me = userInfo().username

	// The user. On a fresh hosted runner it never exists; on a reused
	// self-hosted one it may, from an earlier job.
	if (!sudo(["id", "-u", AGENT_USER]).ok) {
		must(sudo(["useradd", "--create-home", "--shell", "/bin/bash", AGENT_USER]), "creating the agent user")
	}
	// It must have no admin rights. The default sudoers grants a new user
	// nothing; this checks that no rule on this machine says otherwise.
	const rules = sudo(["-l", "-U", AGENT_USER])
	if (/may run the following commands/i.test(rules.out)) {
		throw new Error(`${AGENT_USER} has sudo rights on this machine, so it would not be locked down`)
	}

	// Anything a previous job's agent left running stops now.
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
	// The relay's folder: ours, and readable only by the agent's group, so
	// nothing else on the machine can reach the socket inside it.
	must(sudo(["chown", `${me}:${AGENT_USER}`, layout.relay]), "chown relay")
	must(sudo(["chmod", "750", layout.relay]), "chmod relay")

	// Share the checkout. ACLs give the agent read and write without changing
	// who owns the files, and the "default" entries make files either of us
	// creates usable by the other. Then the checkout is mounted inside the
	// agent's folder, so it never has to walk through our home to reach it.
	must(
		sudo(["setfacl", "-R", "-m", `u:${AGENT_USER}:rwX,d:u:${AGENT_USER}:rwX,u:${me}:rwX,d:u:${me}:rwX,m::rwx,d:m::rwx`, repoDir]),
		"sharing the checkout",
	)
	must(sudo(["mount", "--bind", repoDir, layout.work]), "mounting the checkout")

	// The agent's own copy of the CLI, in its own home. It may change it; it
	// only ever runs as the agent, and we never run this copy.
	must(sudo(["mkdir", "-p", layout.bin, layout.ghConfig]), "creating the agent's home folders")
	must(sudo(["cp", tcPath, `${layout.bin}/tc`]), "copying the CLI")
	must(sudo(["chmod", "755", `${layout.bin}/tc`]), "chmod tc")

	// gh, pointed at the relay. The token is a placeholder: the relay
	// replaces it on the requests it allows, and nothing else accepts it.
	writeAs(`${layout.ghConfig}/config.yml`, `http_unix_socket: ${layout.socket}\nprompt: disabled\n`, `${AGENT_USER}:${AGENT_USER}`, "600")
	writeAs(
		`${layout.ghConfig}/hosts.yml`,
		`github.com:\n    oauth_token: relayed-by-test-companion\n    user: ${AGENT_USER}\n    git_protocol: https\n`,
		`${AGENT_USER}:${AGENT_USER}`,
		"600",
	)
	// git refuses a repository owned by another user unless told it is safe.
	// And a name to commit under: the CLI commits automate's and fix's work
	// on their own branch before handing it back.
	writeAs(
		`${layout.home}/.gitconfig`,
		`[safe]\n\tdirectory = ${layout.work}\n[user]\n\tname = Test Companion\n\temail = test-companion[bot]@users.noreply.github.com\n`,
		`${AGENT_USER}:${AGENT_USER}`,
		"644",
	)
	must(sudo(["chown", "-R", `${AGENT_USER}:${AGENT_USER}`, `${layout.home}/.local`, `${layout.home}/.config`]), "chown home")
	// The launcher asAgentCommand runs. Ours, readable by the agent.
	writeFileSync(`${layout.in}/launch.mjs`, LAUNCHER_SOURCE, { mode: 0o644 })
	return { ...layout, launcher: `${layout.in}/launch.mjs` }
}

/**
 * Hand the agent its environment in a file only its user can read. The
 * launcher deletes it as soon as it has read it. Returns the path.
 */
export function writeAgentEnv(layout, env, name = "env.json") {
	const path = `${layout.tmp}/${name}`
	writeAs(path, JSON.stringify(env), `${AGENT_USER}:${AGENT_USER}`, "600")
	return path
}

/**
 * Stop everything the agent started and unmount the checkout. Run after the
 * agent's run, BEFORE anything reads its files or commits its work: a
 * process it left in the background could otherwise keep changing the tree
 * while we save it.
 */
export function stopSandbox(layout) {
	sudo(["pkill", "-KILL", "-u", AGENT_USER])
	const u = sudo(["umount", layout.work])
	return { unmounted: u.ok }
}

/** Copy one of our files into the agent's `in` folder. Returns the new path. */
export function handToAgent(layout, from, name) {
	const to = `${layout.in}/${name}`
	copyFileSync(from, to)
	return to
}

/** Write content into the agent's `in` folder. Returns the path. */
export function writeForAgent(layout, name, content) {
	const to = `${layout.in}/${name}`
	writeFileSync(to, content)
	return to
}

/**
 * Read a file the agent's run wrote, without trusting it.
 *
 * The agent owns the folder, so the name could be a link to one of our own
 * files: read through a link, its contents would land in the pull request
 * comment. O_NOFOLLOW refuses a link, and only a regular file of a sane size
 * is read. Returns undefined for anything else.
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
