/**
 * The environment the agent's subprocess gets — an allowlist, not a denylist.
 *
 * The run executes shell commands the model chooses, so everything here is
 * readable by them. This is the one place in the Action where a mistake hands
 * away a credential, which is why it lives in its own testable module.
 *
 * A denylist is not enough: a composite action's own inputs can surface as
 * INPUT_* variables, reintroducing the very token a denylist removed. Listing
 * what the CLI needs is the only version that stays correct as the
 * surroundings change.
 *
 * Known gap: `actions/checkout` leaves a credential in .git/config, which
 * this cannot reach.
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
		// Where this job's gh credentials live. A PATH, not a secret — but
		// without it the CLI's gh looks in the runner's shared config, finds
		// nothing, and jobs that read a failed build fail with "not signed
		// in". The token itself still never enters this environment.
		"GH_CONFIG_DIR",
	])
	// The exception to the TC_ prefix below, and the reason this is an explicit
	// list rather than a rule. The App's private key is TC_ACTION_APP_* — it
	// matches the kept prefix, and it can mint installation tokens for every
	// repository the App is installed on. That is a far worse thing to hand a
	// shell than the workflow token this allowlist was written to keep out.
	const NEVER = new Set(["TC_ACTION_APP_ID", "TC_ACTION_APP_PRIVATE_KEY"])
	// TC_* is the CLI's own configuration; BROWSERSTACK_* is how it signs in;
	// the proxy variables matter inside corporate networks.
	const KEEP_PREFIX = ["TC_", "BROWSERSTACK_", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]
	const out = {}
	for (const [k, v] of Object.entries(source)) {
		if (v == null) continue
		if (NEVER.has(k)) continue
		if (KEEP_EXACT.has(k) || KEEP_PREFIX.some((pre) => k.startsWith(pre))) out[k] = v
	}
	return out
}
