import type { Signal } from "../core/types";
import { isRecord } from "../core/validate";
import { matchesAny, normalizeUrl } from "./domains";

/** Compact redirect rule kept in the snapshot: source → destination, status and enabled flag. */
export interface RedirectRule {
	id: string;
	source: string;
	destination: string;
	type: number;
	enabled: boolean;
}

export interface RedirectSnapshot {
	takenAt: string;
	rules: RedirectRule[];
	partial: boolean;
}

export function parseRule(raw: unknown): RedirectRule | undefined {
	if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.source !== "string") return undefined;
	return {
		id: raw.id.slice(0, 64),
		source: raw.source.slice(0, 300),
		destination: typeof raw.destination === "string" ? raw.destination.slice(0, 500) : "",
		type: typeof raw.type === "number" ? raw.type : 0,
		enabled: raw.enabled !== false,
	};
}

export interface RedirectChange {
	kind: "added" | "removed" | "changed";
	rule: RedirectRule;
	previous?: RedirectRule;
	signals: Signal[];
	host?: string;
}

function destinationSignals(rule: RedirectRule, prev: RedirectRule | undefined, siteHost: string | undefined, blocked: readonly string[]): { signals: Signal[]; host?: string } {
	const signals: Signal[] = [];
	const dest = normalizeUrl(rule.destination, siteHost);
	if (!dest?.host || !dest.external) return { signals };
	const before = prev ? normalizeUrl(prev.destination, siteHost) : undefined;
	const wasExternal = before?.external === true;
	if (matchesAny(dest.host, blocked)) signals.push({ code: "redirect.blocked", detail: dest.host });
	if (!wasExternal || before?.host !== dest.host) signals.push({ code: "redirect.external", detail: `${rule.source} → ${dest.host}` });
	if (dest.scheme === "http") signals.push({ code: "redirect.http", detail: dest.host });
	return { signals, host: dest.host };
}

/** Net differences between two snapshots. Changes between snapshots are not individually visible. */
export function diffRedirects(prev: RedirectSnapshot, next: RedirectSnapshot, siteHost: string | undefined, blocked: readonly string[]): RedirectChange[] {
	const before = new Map(prev.rules.map((r) => [r.id, r]));
	const after = new Map(next.rules.map((r) => [r.id, r]));
	const changes: RedirectChange[] = [];
	for (const rule of next.rules) {
		const old = before.get(rule.id);
		if (!old) {
			const d = destinationSignals(rule, undefined, siteHost, blocked);
			changes.push({ kind: "added", rule, signals: [{ code: "redirect.added", detail: `${rule.source} → ${rule.destination}` }, ...d.signals], ...(d.host ? { host: d.host } : {}) });
		} else if (old.destination !== rule.destination || old.source !== rule.source || old.type !== rule.type || old.enabled !== rule.enabled) {
			const d = destinationSignals(rule, old, siteHost, blocked);
			changes.push({
				kind: "changed",
				rule,
				previous: old,
				signals: [{ code: "redirect.changed", detail: old.destination !== rule.destination ? `${rule.source}: ${old.destination} → ${rule.destination}` : `${rule.source} settings changed` }, ...d.signals],
				...(d.host ? { host: d.host } : {}),
			});
		}
	}
	// Removals are only reliable when both snapshots are complete.
	if (!prev.partial && !next.partial) {
		for (const rule of prev.rules) {
			if (!after.has(rule.id)) changes.push({ kind: "removed", rule, signals: [{ code: "redirect.removed", detail: rule.source }] });
		}
	}
	return changes;
}
