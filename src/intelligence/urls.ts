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
const TAG_RE = /<\s*(script|iframe|embed|object|form|a|img|link|source|video|audio|frame|base)\b([^>]*)>/gi;
const ATTR_RE = /\b(src|href|action|data|formaction|poster)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const HANDLER_TAG_RE = /<[a-z][a-z0-9-]*\b[^>]*?\son[a-z]{3,20}\s*=/gi;
const EMBED_TYPE_RE = /embed|iframe|script|html|widget|object/i;

const TAG_KIND: Record<string, RefKind> = {
	script: "script",
	iframe: "iframe",
	frame: "iframe",
	embed: "object",
	object: "object",
	form: "form",
	a: "link",
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
		partial: false,
	};
	private readonly seen = new Set<string>();
	nodes = 0;
	chars = 0;

	constructor(private readonly siteHost?: string) {}

	add(raw: string, kind: RefKind): void {
		if (this.result.refs.length >= LIMITS.refs) {
			this.result.partial = true;
			return;
		}
		const normalized = normalizeUrl(raw, this.siteHost);
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
				const rawValue = (attr[2] ?? "").replace(/^["']|["']$/g, "");
				if (!rawValue) continue;
				hasSrc = true;
				const attrName = (attr[1] ?? "").toLowerCase();
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
export function externalHosts(extraction: Pick<Extraction, "refs">): string[] {
	const hosts = new Set<string>();
	for (const ref of extraction.refs) if (ref.external && ref.host) hosts.add(ref.host);
	return [...hosts];
}
