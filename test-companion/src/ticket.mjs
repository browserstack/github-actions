/**
 * The ticket this change is for.
 *
 * A run tests against what the ticket asks for, not only what the diff does,
 * so finding the key comes first. People put it in the branch name far more
 * often than anywhere else, but the title is where they correct it.
 *
 * Pure: three strings in, a key or nothing out.
 */

/**
 * A Jira-style key: a project of two or more letters, a hyphen, a number.
 *
 * Each lookaround guards a different mistake:
 *  (?<![A-Za-z0-9]) so "AX-12" does not also read as "X-12"
 *  (?!\d) so the whole number is taken
 *  (?!-\d) so "FOO-2026-1234" — a CVE shape — is not a key
 *
 * A trailing hyphen followed by WORDS must stay: branch names look like
 * "feat/PROJ-12-add-discount-code", the commonest place a key appears.
 */
const KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+)-(\d+)(?!\d)(?!-\d)/

/**
 * Prefixes shaped like a ticket key that never are one.
 *
 * "upgrade to UTF-8" would otherwise produce a run that tests against ticket
 * UTF-8 and says so in its first comment. A wrong ticket is worse than none:
 * the run reads something irrelevant and treats it as the requirement.
 */
const NOT_TICKETS = new Set([
	"UTF",
	"SHA",
	"HTTP",
	"HTTPS",
	"RFC",
	"ISO",
	"AES",
	"RSA",
	"MD",
	"SSL",
	"TLS",
	"IPV",
	"CVE",
	"ES",
	"UTC",
	"GMT",
	"BASE",
	"X",
])

/** The first real key in `text`, or undefined. */
function keyIn(text) {
	let rest = String(text ?? "")
	// Walk forward: the first MATCH may be a false positive, and the real key
	// can sit behind it ("UTF-8 fixes for PROJ-12").
	for (let guard = 0; guard < 20; guard++) {
		const m = KEY.exec(rest)
		if (!m) return undefined
		if (!NOT_TICKETS.has(m[1])) return `${m[1]}-${m[2]}`
		rest = rest.slice(m.index + m[0].length)
	}
	return undefined
}

/**
 * Title first, then branch, then description — a person edits the title last,
 * so it is the most deliberate of the three.
 */
export function findTicket({ title, branch, body } = {}) {
	return keyIn(title) ?? keyIn(branch) ?? keyIn(body)
}
