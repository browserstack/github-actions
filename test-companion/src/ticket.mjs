/**
 * The ticket this change is for — STM-5434 FR-37.
 *
 * FR-37 wants the run to test against what the ticket actually asks for, not
 * only what the diff does, so finding the key is the first step. People put it
 * in the branch name far more often than anywhere else, but the title is where
 * they correct it.
 *
 * Pure: three strings in, a key or nothing out.
 */

/**
 * A Jira-style key: a project of two or more letters, a hyphen, a number.
 *
 * The lookarounds matter, and each guards a different mistake:
 *   (?<![A-Za-z0-9])  so "XSHOP-221" reads as XSHOP-221, not SHOP-221
 *   (?!\d)            so the whole number is taken
 *   (?!-\d)           so "FOO-2026-1234" — a CVE shape — is not a key
 *
 * A trailing hyphen followed by WORDS is fine and must stay: branch names look
 * like "feat/SHOP-221-add-discount-code", which is the commonest place a key
 * appears at all.
 */
const KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+)-(\d+)(?!\d)(?!-\d)/

/**
 * Prefixes that are the same shape as a ticket key and are never one.
 *
 * This is the trap worth guarding: "upgrade to UTF-8" otherwise produces a run
 * that tests against ticket UTF-8 and says so, confidently, in the first
 * comment it posts (FR-38). A wrong ticket is worse than no ticket, because
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
	// can sit behind it ("UTF-8 fixes for SHOP-221").
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
