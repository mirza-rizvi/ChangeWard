/**
 * Standards-based URL and host handling. Parsing is always done with the WHATWG
 * `URL` parser; regexes only pre-clean input or classify an already-parsed host.
 */

export type Scheme = "http" | "https" | "javascript" | "data" | "vbscript" | "mailto" | "tel" | "other" | "relative";

export interface NormalizedUrl {
	/** Serialized URL (host lowercased, punycode, default port removed). */
	href: string;
	scheme: Scheme;
	/** ASCII (punycode) hostname for http(s) URLs. */
	host?: string;
	external: boolean;
	ipLiteral: boolean;
	punycode: boolean;
}

const PLACEHOLDER_BASE = "https://changeward.invalid/";
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Browsers strip ASCII tab/newline anywhere and leading C0 controls/space; mirror that before parsing. */
function preclean(raw: string): string {
	// eslint-disable-next-line no-control-regex
	return raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
}

export function hostOf(siteUrl: string | undefined): string | undefined {
	if (!siteUrl) return undefined;
	try {
		return new URL(siteUrl).hostname || undefined;
	} catch {
		return undefined;
	}
}

function schemeOf(protocol: string): Scheme {
	switch (protocol) {
		case "http:":
			return "http";
		case "https:":
			return "https";
		case "javascript:":
			return "javascript";
		case "data:":
			return "data";
		case "vbscript:":
			return "vbscript";
		case "mailto:":
			return "mailto";
		case "tel:":
			return "tel";
		default:
			return "other";
	}
}

const ABSOLUTE_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Normalize a URL reference. Relative references resolve against the site and are internal.
 * Returns undefined for values the URL parser rejects.
 */
export function normalizeUrl(raw: string, siteHost?: string): NormalizedUrl | undefined {
	const cleaned = preclean(raw);
	if (cleaned.length === 0 || cleaned.length > 4096) return undefined;
	const absolute = ABSOLUTE_RE.test(cleaned) || cleaned.startsWith("//");
	let url: URL;
	try {
		url = new URL(cleaned, siteHost ? `https://${siteHost}/` : PLACEHOLDER_BASE);
	} catch {
		return undefined;
	}
	const scheme: Scheme = absolute ? schemeOf(url.protocol) : "relative";
	if (scheme === "javascript" || scheme === "data" || scheme === "vbscript") {
		// Keep only the scheme and a short prefix; never store full script or data payloads.
		return { href: `${scheme}:${url.pathname.slice(0, 40)}`, scheme, external: false, ipLiteral: false, punycode: false };
	}
	if (scheme === "relative") {
		return { href: url.pathname + url.search, scheme, external: false, ipLiteral: false, punycode: false };
	}
	if (scheme !== "http" && scheme !== "https") {
		return { href: `${scheme}:`, scheme, external: false, ipLiteral: false, punycode: false };
	}
	// A fully qualified name with a trailing dot is the same host; lists never contain the dot.
	const host = url.hostname.endsWith(".") ? url.hostname.replace(/\.+$/, "") : url.hostname;
	if (!host) return undefined;
	const external = !siteHost || !sameSite(host, siteHost);
	// Data minimization: never keep credentials, query strings or fragments.
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return {
		href: `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${url.pathname}`.slice(0, 300),
		scheme,
		host,
		external,
		ipLiteral: isIpLiteral(host),
		punycode: isPunycode(host),
	};
}

export function isIpLiteral(host: string): boolean {
	return host.startsWith("[") || IPV4_RE.test(host);
}

export function isPunycode(host: string): boolean {
	return host.split(".").some((label) => label.startsWith("xn--"));
}

function stripWww(host: string): string {
	return host.startsWith("www.") ? host.slice(4) : host;
}

/** `www.` is treated as the same site; other subdomains are not. */
export function sameSite(a: string, b: string): boolean {
	return stripWww(a) === stripWww(b);
}

/** A list entry matches the host itself and any subdomain of it. */
export function matchesDomain(host: string, entry: string): boolean {
	return host === entry || host.endsWith(`.${entry}`);
}

export function matchesAny(host: string, entries: readonly string[]): string | undefined {
	return entries.find((entry) => matchesDomain(host, entry));
}

/**
 * Normalize an administrator-entered domain (`Example.COM`, `https://example.com/x`, `*.example.com`)
 * to its ASCII hostname. Returns undefined for anything that is not a plain hostname.
 */
export function normalizeDomainEntry(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let s = value.trim().toLowerCase();
	if (s.length === 0 || s.length > 300) return undefined;
	if (s.startsWith("*.")) s = s.slice(2);
	if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
		try {
			s = new URL(s).hostname;
		} catch {
			return undefined;
		}
	}
	if (s.endsWith(".")) s = s.slice(0, -1);
	if (!/^[^\s/?#@:]+$/.test(s)) return undefined;
	let host: string;
	try {
		host = new URL(`https://${s}/`).hostname;
	} catch {
		return undefined;
	}
	if (!host || host.length > 253 || isIpLiteral(host) || !host.includes(".")) return undefined;
	return host;
}

export type DomainStatus = "blocked" | "trusted" | "observed" | "new";

export interface DomainClassification {
	host: string;
	status: DomainStatus;
	punycode: boolean;
	ipLiteral: boolean;
}

export function classifyDomain(
	host: string,
	lists: { trusted: readonly string[]; blocked: readonly string[] },
	observed: ReadonlySet<string>,
): DomainClassification {
	const status: DomainStatus = matchesAny(host, lists.blocked)
		? "blocked"
		: matchesAny(host, lists.trusted)
			? "trusted"
			: observed.has(host)
				? "observed"
				: "new";
	return { host, status, punycode: isPunycode(host), ipLiteral: isIpLiteral(host) };
}
