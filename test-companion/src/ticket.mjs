/** Find the ticket key a change is for, from its title, branch or body. */

/**
 * A Jira-style key such as PROJ-12. `(?!-\d)` rejects CVE-like "FOO-2026-1234"
 * but keeps "PROJ-12-add-discount-code".
 */
const KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+)-(\d+)(?!\d)(?!-\d)/

/** Prefixes shaped like a key that never are one, such as UTF-8. */
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

function keyIn(text) {
	let rest = String(text ?? "")
	// Keep looking past false positives ("UTF-8 fixes for PROJ-12").
	for (let guard = 0; guard < 20; guard++) {
		const m = KEY.exec(rest)
		if (!m) return undefined
		if (!NOT_TICKETS.has(m[1])) return `${m[1]}-${m[2]}`
		rest = rest.slice(m.index + m[0].length)
	}
	return undefined
}

/** Title first: it is the most deliberate of the three. */
export function findTicket({ title, branch, body } = {}) {
	return keyIn(title) ?? keyIn(branch) ?? keyIn(body)
}
