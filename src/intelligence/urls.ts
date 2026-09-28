import { LIMITS } from "../core/limits";
import { normalizeUrl, type NormalizedUrl } from "./domains";

export type RefKind = "link" | "script" | "iframe" | "object" | "form" | "image" | "stylesheet" | "media" | "text";

export interface Ref extends NormalizedUrl {
	kind: RefKind;
}

export interface Extraction {
	refs: Ref[];
	/** Inline `<script>` elements without `src`. */
	inlineScripts: number;
	/** HTML elements with inline `on*=` event-handler attributes. */
	inlineHandlers: number;
	/** Structured blocks whose type names an embed (e.g. Portable Text `_type: "embed"`). */
	embedBlocks: string[];
	/** Top-level string fields that hold a single URL (CTA, download link…), field → href. */
	urlFields: Record<string, string>;
	/** External hosts seen after the reference cap was reached (still checked against lists). */
	overflowHosts: string[];
	partial: boolean;
}

const URL_KEYS: Record<string, RefKind> = {
	href: "link",
	url: "link",
	link: "link",
	src: "media",
	action: "form",
	formaction: "form",
	data: "object",
	poster: "media",
};

const URLISH_RE = /^\s*(?:https?:|\/\/|javascript:|data:|vbscript:|mailto:|tel:)/i;
const TEXT_URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
// Attribute text may contain ">" inside quotes, so quoted values are consumed as units.
const TAG_RE = /<\s*(script|iframe|embed|object|form|a|area|img|link|source|video|audio|frame|base|button|input|meta|use|image)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTR_RE = /(?:^|[\s"'/])((?:xlink:)?href|src|srcset|action|data|formaction|poster|content)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", period: ".", tab: "\t", newline: "\n", lpar: "(", rpar: ")", comma: ",", num: "#", quest: "?", equals: "=" };

/** Decode character references the way a browser does before it resolves an attribute URL. */
export function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ref: string) => {
		if (ref[0] === "#") {
			const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
		}
		return NAMED_ENTITIES[ref.toLowerCase()] ?? m;
	});
}
const HANDLER_TAG_RE = /<[a-z][a-z0-9-]*\b[^>]*?\son[a-z]{3,20}\s*=/gi;
const EMBED_TYPE_RE = /embed|iframe|script|html|widget|object/i;

const TAG_KIND: Record<string, RefKind> = {
	script: "script",
	iframe: "iframe",
	frame: "iframe",
	embed: "object",
	object: "object",
	form: "form",
	button: "form",
	input: "form",
	a: "link",
	area: "link",
	meta: "link",
	use: "object",
	image: "image",
	img: "image",
	link: "stylesheet",
	source: "media",
	video: "media",
	audio: "media",
	base: "link",
};

class Collector {
	readonly result: Extraction = {
		refs: [],
		inlineScripts: 0,
		inlineHandlers: 0,
		embedBlocks: [],
		urlFields: {},
		overflowHosts: [],
		partial: false,
	};
	private readonly seen = new Set<string>();
	nodes = 0;
	chars = 0;

	constructor(private readonly siteHost?: string) {}

	add(raw: string, kind: RefKind): void {
		const normalized = normalizeUrl(raw, this.siteHost);
		if (this.result.refs.length >= LIMITS.refs) {
			this.result.partial = true;
			const overflow = this.result.overflowHosts;
			if (normalized?.external && normalized.host && overflow.length < 2000 && !overflow.includes(normalized.host)) overflow.push(normalized.host);
			return;
		}
		if (!normalized || normalized.scheme === "relative" || normalized.scheme === "mailto" || normalized.scheme === "tel" || normalized.scheme === "other") {
			return;
		}
		const key = `${kind}|${normalized.href}`;
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.result.refs.push({ ...normalized, kind });
	}

	scanString(value: string, key: string | undefined): void {
		const budget = LIMITS.scanChars - this.chars;
		if (budget <= 0) {
			this.result.partial = true;
			return;
		}
		let text = value;
		const cap = Math.min(budget, LIMITS.stringChars);
		if (text.length > cap) {
			text = text.slice(0, cap);
			this.result.partial = true;
		}
		this.chars += text.length;

		const lowerKey = key?.toLowerCase();
		if (lowerKey && lowerKey in URL_KEYS && URLISH_RE.test(text)) {
			this.add(text, URL_KEYS[lowerKey] ?? "link");
			return;
		}
		if (URLISH_RE.test(text) && !/\s/.test(text.trim())) {
			this.add(text, "link");
			return;
		}
		if (text.includes("<")) this.scanMarkup(text);
		for (const match of text.matchAll(TEXT_URL_RE)) this.add(match[0], "text");
	}

	/** Lightweight tag scan. Not an HTML parser: it reports references, it does not sanitize. */
	private scanMarkup(text: string): void {
		for (const tag of text.matchAll(TAG_RE)) {
			const name = (tag[1] ?? "").toLowerCase();
			const attrs = tag[2] ?? "";
			const kind = TAG_KIND[name] ?? "link";
			let hasSrc = false;
			for (const attr of attrs.matchAll(ATTR_RE)) {
				const rawValue = decodeEntities((attr[2] ?? "").replace(/^["']|["']$/g, ""));
				if (!rawValue) continue;
				const attrName = (attr[1] ?? "").toLowerCase();
				if (attrName === "content") {
					// <meta http-equiv="refresh" content="0; url=...">
					const refresh = /url\s*=\s*['"]?([^'";\s]+)/i.exec(rawValue);
					if (name === "meta" && refresh?.[1]) this.add(refresh[1], "link");
					continue;
				}
				hasSrc = true;
				if (attrName === "srcset") {
					for (const candidate of rawValue.split(",")) {
						const u = candidate.trim().split(/\s+/)[0];
						if (u) this.add(u, kind);
					}
					continue;
				}
				this.add(rawValue, attrName === "formaction" ? "form" : kind);
			}
			if (name === "script" && !hasSrc) this.result.inlineScripts += 1;
		}
		for (const _ of text.matchAll(HANDLER_TAG_RE)) this.result.inlineHandlers += 1;
	}
}

function walk(value: unknown, key: string | undefined, depth: number, c: Collector): void {
	if (c.nodes >= LIMITS.walkNodes || depth > LIMITS.walkDepth) {
		c.result.partial = true;
		return;
	}
	c.nodes += 1;
	if (typeof value === "string") {
		c.scanString(value, key);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) walk(item, key, depth + 1, c);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	const type = record._type;
	if (typeof type === "string" && EMBED_TYPE_RE.test(type) && type !== "code" && c.result.embedBlocks.length < 10) {
		if (!c.result.embedBlocks.includes(type)) c.result.embedBlocks.push(type.slice(0, 40));
	}
	for (const [k, v] of Object.entries(record)) {
		if (k === "_key" || k === "_type") continue;
		walk(v, k, depth + 1, c);
	}
}

/** Extract external references and embed markers from a content `data` object. Bounded; never throws. */
export function extract(data: unknown, siteHost?: string): Extraction {
	const c = new Collector(siteHost);
	if (typeof data === "object" && data !== null && !Array.isArray(data)) {
		for (const [field, value] of Object.entries(data as Record<string, unknown>)) {
			if (typeof value === "string" && Object.keys(c.result.urlFields).length < LIMITS.urlFields) {
				const trimmed = value.trim();
				if (URLISH_RE.test(trimmed) && !/\s/.test(trimmed)) {
					const n = normalizeUrl(trimmed, siteHost);
					if (n && n.host) c.result.urlFields[field.slice(0, 64)] = n.host;
				}
			}
		}
	}
	walk(data, undefined, 0, c);
	return c.result;
}

export function refKey(ref: Ref): string {
	return `${ref.kind}|${ref.href}`;
}

/** Hosts of external http(s) references. */
export function externalHosts(extraction: Pick<Extraction, "refs"> & { overflowHosts?: string[] }): string[] {
	const hosts = new Set<string>();
	for (const ref of extraction.refs) if (ref.external && ref.host) hosts.add(ref.host);
	for (const host of extraction.overflowHosts ?? []) hosts.add(host);
	return [...hosts];
}
