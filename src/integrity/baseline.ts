import { LIMITS } from "../core/limits";
import type { Baseline } from "../core/types";

export interface Drift {
	changed: boolean;
	hashChanged: boolean;
	domainsAdded: string[];
	domainsRemoved: string[];
	statusChanged?: { from: string; to: string };
}

export function makeBaseline(input: {
	hash: string;
	hosts: readonly string[];
	status: string;
	capturedAt: string;
	capturedBy?: string;
	partial?: boolean;
}): Baseline {
	return {
		hash: input.hash,
		domains: [...new Set(input.hosts)].sort().slice(0, LIMITS.baselineDomains),
		status: input.status,
		capturedAt: input.capturedAt,
		...(input.capturedBy ? { capturedBy: input.capturedBy } : {}),
		...(input.partial ? { partial: true } : {}),
	};
}

export function compareToBaseline(
	baseline: Baseline,
	current: { hash: string; hosts: readonly string[]; status?: string },
): Drift {
	const now = new Set(current.hosts);
	const then = new Set(baseline.domains);
	const domainsAdded = [...now].filter((h) => !then.has(h)).sort().slice(0, LIMITS.eventDomains);
	// Hosts beyond the stored cap cannot be judged "removed" reliably.
	const domainsRemoved =
		baseline.domains.length >= LIMITS.baselineDomains ? [] : [...then].filter((h) => !now.has(h)).sort().slice(0, LIMITS.eventDomains);
	const hashChanged = baseline.hash !== current.hash;
	const statusChanged =
		current.status !== undefined && current.status !== baseline.status ? { from: baseline.status, to: current.status } : undefined;
	return {
		changed: hashChanged || domainsAdded.length > 0 || domainsRemoved.length > 0 || statusChanged !== undefined,
		hashChanged,
		domainsAdded,
		domainsRemoved,
		...(statusChanged ? { statusChanged } : {}),
	};
}

export function describeDrift(drift: Drift): string[] {
	if (!drift.changed) return ["Matches the known good state."];
	const lines: string[] = [];
	if (drift.hashChanged) lines.push("Content fingerprint changed.");
	if (drift.domainsAdded.length) lines.push(`${drift.domainsAdded.length} external domain(s) introduced: ${drift.domainsAdded.join(", ")}`);
	if (drift.domainsRemoved.length) lines.push(`${drift.domainsRemoved.length} external domain(s) removed: ${drift.domainsRemoved.join(", ")}`);
	if (drift.statusChanged) lines.push(`Status changed from ${drift.statusChanged.from} to ${drift.statusChanged.to}.`);
	return lines;
}
