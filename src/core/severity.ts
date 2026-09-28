import type { OriginSource, Severity, Signal, SignalCode } from "./types";

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const BY_RANK: Severity[] = ["info", "low", "medium", "high", "critical"];

export function maxSeverity(...values: Severity[]): Severity {
	let rank = 0;
	for (const v of values) rank = Math.max(rank, SEVERITY_RANK[v]);
	return BY_RANK[rank] ?? "info";
}

export function atLeast(value: Severity, min: Severity): boolean {
	return SEVERITY_RANK[value] >= SEVERITY_RANK[min];
}

/** Base severity of each observation on ordinary (unprotected) content. */
const BASE: Partial<Record<SignalCode, Severity>> = {
	"domain.new": "low",
	"domain.punycode": "low",
	"domain.ip": "low",
	"domain.blocked": "medium",
	"url.http": "low",
	"url.changed": "low",
	"url.javascript": "high",
	"url.data": "medium",
	"embed.script": "medium",
	"embed.inline-script": "medium",
	"embed.iframe": "medium",
	"embed.object": "medium",
	"embed.form": "medium",
	"embed.handler": "medium",
	"embed.block": "low",
	"links.many": "low",
	"integrity.drift": "low",
	"media.svg": "low",
	"media.html": "medium",
	"media.double-extension": "medium",
	"media.executable": "medium",
	"redirect.added": "low",
	"redirect.removed": "low",
	"redirect.changed": "low",
	"redirect.http": "low",
	"redirect.external": "medium",
	"redirect.blocked": "high",
	"volume.bulk": "medium",
	"policy.warn": "low",
	"policy.block": "medium",
};

/** On protected resources these observations are raised to high. */
const PROTECTED_HIGH: ReadonlySet<SignalCode> = new Set<SignalCode>([
	"domain.blocked",
	"embed.script",
	"embed.inline-script",
	"url.data",
	"volume.bulk",
]);

export interface SeverityInput {
	signals: readonly Signal[];
	protectedResource: boolean;
	origin: OriginSource;
	/** content action: save, publish, unpublish, schedule, delete, restore… */
	action: string;
}

/**
 * Deterministic event severity. See docs/INCIDENT_MODEL.md for the table this implements.
 * The function never returns "critical": critical is reserved for correlated incidents.
 */
export function eventSeverity(input: SeverityInput): Severity {
	let result: Severity = "info";
	for (const s of input.signals) {
		let sev = BASE[s.code] ?? "info";
		if (input.protectedResource && PROTECTED_HIGH.has(s.code)) sev = "high";
		result = maxSeverity(result, sev);
	}
	if (input.protectedResource) {
		const automation = input.origin === "mcp" || input.origin === "api" || input.origin === "plugin";
		const removal = input.action === "delete" || input.action === "trash" || input.action === "unpublish";
		// Any change to protected content is at least low; automation changes and removals are medium.
		result = maxSeverity(result, automation || removal ? "medium" : "low");
		// Publishing a protected resource that carries a medium observation is high.
		if ((input.action === "publish" || input.action === "schedule") && SEVERITY_RANK[result] >= SEVERITY_RANK.medium) {
			const hasMediumSignal = input.signals.some((s) => SEVERITY_RANK[BASE[s.code] ?? "info"] >= SEVERITY_RANK.medium);
			if (hasMediumSignal) result = maxSeverity(result, "high");
		}
	}
	return result;
}
