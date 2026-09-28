import { LIMITS } from "../core/limits";
import type { RefMarkers, Signal } from "../core/types";
import { classifyDomain, normalizeUrl, type DomainClassification } from "./domains";
import { externalHosts, refKey, type Extraction, type Ref, type RefKind } from "./urls";

/** The comparable shape of a previous state: either a stored snapshot or a fresh extraction. */
export interface RefSnapshot {
	keys: Set<string>;
	hosts: Set<string>;
	urlFields: Record<string, string>;
	markers: RefMarkers;
}

export function snapshotOf(extraction: Extraction): RefSnapshot {
	return {
		keys: new Set(extraction.refs.map(refKey)),
		hosts: new Set(externalHosts(extraction)),
		urlFields: { ...extraction.urlFields },
		markers: markersOf(extraction),
	};
}

export function markersOf(extraction: Extraction): RefMarkers {
	return {
		inlineScripts: extraction.inlineScripts,
		inlineHandlers: extraction.inlineHandlers,
		embedBlocks: [...extraction.embedBlocks],
	};
}

/** Rebuild a snapshot from the compact `kind|href` strings kept on a resource record. */
export function snapshotFromStored(
	refs: readonly string[] | undefined,
	urlFields: Record<string, string> | undefined,
	markers: RefMarkers | undefined,
	siteHost?: string,
): RefSnapshot {
	const keys = new Set<string>();
	const hosts = new Set<string>();
	for (const key of refs ?? []) {
		keys.add(key);
		const href = key.slice(key.indexOf("|") + 1);
		const n = normalizeUrl(href, siteHost);
		if (n?.external && n.host) hosts.add(n.host);
	}
	return {
		keys,
		hosts,
		urlFields: { ...(urlFields ?? {}) },
		markers: markers ?? { inlineScripts: 0, inlineHandlers: 0, embedBlocks: [] },
	};
}

/** Refs worth keeping for the next comparison, most security-relevant first. */
export function storedRefs(extraction: Extraction): string[] {
	const rank: Record<RefKind, number> = { script: 0, iframe: 0, object: 0, form: 1, stylesheet: 1, link: 2, media: 3, image: 3, text: 4 };
	return [...extraction.refs]
		.sort((a, b) => rank[a.kind] - rank[b.kind])
		.slice(0, LIMITS.storedRefs)
		.map(refKey);
}

export interface Analysis {
	signals: Signal[];
	introducedDomains: DomainClassification[];
	removedDomains: string[];
	/** External hosts present after the change. */
	hosts: string[];
	introducedRefs: Ref[];
	partial: boolean;
}

export interface ClassifyOptions {
	trusted: readonly string[];
	blocked: readonly string[];
	observed: ReadonlySet<string>;
	/**
	 * Previous state unknown (existing entry seen for the first time). Only blocked domains and
	 * dangerous schemes are reported, so installing ChangeWard does not flood the log.
	 */
	firstSeen?: boolean;
}

const EMBED_SIGNAL: Partial<Record<RefKind, Signal["code"]>> = {
	script: "embed.script",
	iframe: "embed.iframe",
	object: "embed.object",
	form: "embed.form",
};

function push(signals: Signal[], signal: Signal): void {
	if (signals.length < 40) signals.push(signal);
}

/**
 * Security-oriented diff between a previous state and a new extraction. Deterministic,
 * bounded, and phrased as observations: nothing here claims intent or maliciousness.
 */
export function classifyChange(before: RefSnapshot | null, after: Extraction, opts: ClassifyOptions): Analysis {
	const signals: Signal[] = [];
	const prev = before ?? { keys: new Set<string>(), hosts: new Set<string>(), urlFields: {}, markers: { inlineScripts: 0, inlineHandlers: 0, embedBlocks: [] } };
	const lists = { trusted: opts.trusted, blocked: opts.blocked };
	const hosts = externalHosts(after);
	const introducedRefs = after.refs.filter((ref) => !prev.keys.has(refKey(ref)));

	const introducedDomains: DomainClassification[] = [];
	for (const host of hosts) {
		if (prev.hosts.has(host)) continue;
		const c = classifyDomain(host, lists, opts.observed);
		if (opts.firstSeen && c.status !== "blocked") continue;
		introducedDomains.push(c);
	}
	for (const d of introducedDomains) {
		if (d.status === "blocked") push(signals, { code: "domain.blocked", detail: d.host });
		else if (d.status === "new") push(signals, { code: "domain.new", detail: d.host });
		else if (d.status === "observed") push(signals, { code: "domain.observed", detail: d.host });
		else push(signals, { code: "domain.trusted", detail: d.host });
		if (d.punycode) push(signals, { code: "domain.punycode", detail: d.host });
		if (d.ipLiteral) push(signals, { code: "domain.ip", detail: d.host });
	}
	const afterHosts = new Set(hosts);
	const removedDomains = opts.firstSeen ? [] : [...prev.hosts].filter((h) => !afterHosts.has(h)).slice(0, LIMITS.eventDomains);
	for (const host of removedDomains) push(signals, { code: "domain.removed", detail: host });

	let introducedExternalLinks = 0;
	for (const ref of introducedRefs) {
		if (ref.scheme === "javascript" || ref.scheme === "vbscript") {
			push(signals, { code: "url.javascript", detail: `${ref.kind}: ${ref.scheme}: URL` });
			continue;
		}
		if (ref.scheme === "data") {
			// data: images are common and inert as <img>; data: in links, frames and scripts is notable.
			if (ref.kind !== "image" && ref.kind !== "media" && ref.kind !== "text") {
				push(signals, { code: "url.data", detail: `${ref.kind}: data: URL` });
			}
			continue;
		}
		if (opts.firstSeen) continue;
		if (ref.external && ref.scheme === "http") push(signals, { code: "url.http", detail: ref.host });
		const embed = EMBED_SIGNAL[ref.kind];
		if (embed && ref.external) push(signals, { code: embed, detail: ref.host });
		if (ref.external && (ref.kind === "link" || ref.kind === "text")) introducedExternalLinks += 1;
	}
	if (!opts.firstSeen) {
		const m = markersOf(after);
		if (m.inlineScripts > prev.markers.inlineScripts) push(signals, { code: "embed.inline-script", detail: `${m.inlineScripts - prev.markers.inlineScripts} added` });
		if (m.inlineHandlers > prev.markers.inlineHandlers) push(signals, { code: "embed.handler", detail: `${m.inlineHandlers - prev.markers.inlineHandlers} added` });
		for (const type of m.embedBlocks) {
			if (!prev.markers.embedBlocks.includes(type)) push(signals, { code: "embed.block", detail: type });
		}
		if (introducedExternalLinks >= LIMITS.manyLinks) push(signals, { code: "links.many", detail: `${introducedExternalLinks} external links added` });
		if (before) {
			for (const [field, host] of Object.entries(after.urlFields)) {
				const old = prev.urlFields[field];
				if (old && old !== host) push(signals, { code: "url.changed", detail: `${field}: ${old} → ${host}` });
			}
		}
	}
	if (after.partial) push(signals, { code: "analysis.partial" });
	if (opts.firstSeen) push(signals, { code: "analysis.first-seen" });

	return { signals, introducedDomains, removedDomains, hosts, introducedRefs, partial: after.partial };
}
