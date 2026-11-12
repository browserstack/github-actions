/**
 * The agent's environment, as an allowlist: a composite action's inputs can
 * reappear as INPUT_* variables, which a denylist would miss.
 */
export function childEnvFor(source) {
	const KEEP_EXACT = new Set([
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"TERM",
		"TMPDIR",
		"TZ",
		"LANG",
		"LC_ALL",
		"CI",
		"RUNNER_OS",
		"RUNNER_ARCH",
		"RUNNER_TEMP",
		// A path, not a secret; the CLI's gh needs it to find its config.
		"GH_CONFIG_DIR",
	])
	// The App credentials match the TC_ prefix but must never reach the agent.
	const NEVER = new Set(["TC_ACTION_APP_ID", "TC_ACTION_APP_PRIVATE_KEY"])
	const KEEP_PREFIX = ["TC_", "BROWSERSTACK_", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]
	const out = {}
	for (const [k, v] of Object.entries(source)) {
		if (v == null) continue
		if (NEVER.has(k)) continue
		if (KEEP_EXACT.has(k) || KEEP_PREFIX.some((pre) => k.startsWith(pre))) out[k] = v
	}
	return out
}
