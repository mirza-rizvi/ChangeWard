import { LIMITS } from "../core/limits";
import { SEVERITY_RANK, atLeast, maxSeverity } from "../core/severity";
import type { Attribution, Incident, Severity } from "../core/types";
import { nextIncidentId, type ActivityState } from "../events/state";

export interface CorrelationEvent {
	createdAt: string;
	resourceKey?: string;
	resourceLabel?: string;
	originKey: string;
	attribution: Attribution;
	domains: string[];
	severity: Severity;
	protectedResource: boolean;
	summary: string;
	/** Why the event is noteworthy on its own, for the first incident reason. */
	trigger?: string;
}

export interface CorrelationResult {
	incident?: Incident;
	isNew: boolean;
	/** Severity before this event, to detect escalation. */
	previousSeverity?: Severity;
}

function addCapped<T>(list: T[], value: T | undefined, cap: number): void {
	if (value === undefined || list.includes(value) || list.length >= cap) return;
	list.push(value);
}

/** Origin keys without an actor or plugin (e.g. `unattributed:-`) are too vague to correlate on. */
function specific(originKey: string): boolean {
	return !originKey.endsWith(":-");
}

function matchReasons(incident: Incident, e: CorrelationEvent): string[] {
	const reasons: string[] = [];
	if (e.resourceKey && incident.resourceKeys.includes(e.resourceKey)) reasons.push(`Same resource (${e.resourceLabel ?? e.resourceKey})`);
	if (specific(e.originKey) && incident.originKeys.includes(e.originKey)) reasons.push(`Same origin and actor (${e.originKey})`);
	const shared = e.domains.filter((d) => incident.domains.includes(d));
	if (shared.length) reasons.push(`Shared domain ${shared.slice(0, 3).join(", ")}`);
	return reasons;
}

/**
 * Incident severity: the highest event severity, then
 * - at least high when medium-or-worse activity spans 3+ protected resources;
 * - critical when high-severity events touched 2+ distinct protected resources.
 */
export function incidentSeverity(incident: Incident): Severity {
	let sev = incident.severity;
	if (incident.protectedResourceKeys.length >= 3 && atLeast(sev, "medium")) sev = maxSeverity(sev, "high");
	if (incident.highProtectedKeys.length >= 2) sev = "critical";
	return sev;
}

/**
 * Attach the event to the best matching open incident, or open a new one for a noteworthy event.
 * Mutates `state.incidents` (the correlation cache). Deterministic for a given state and event.
 */
export function correlate(state: ActivityState, e: CorrelationEvent, windowMs: number): CorrelationResult {
	const now = Date.parse(e.createdAt);
	const notable = atLeast(e.severity, "medium");
	let best: { incident: Incident; reasons: string[] } | undefined;
	for (const incident of state.incidents) {
		if (now - Date.parse(incident.lastEventAt) > windowMs) continue;
		const reasons = matchReasons(incident, e);
		if (reasons.length === 0) continue;
		// Ordinary events join only through the same resource or the same identified actor/plugin;
		// a shared domain alone links only noteworthy events.
		const direct = reasons.some((r) => r.startsWith("Same resource") || r.startsWith("Same origin"));
		if (!notable && !direct) continue;
		if (!best || reasons.length > best.reasons.length || (reasons.length === best.reasons.length && incident.lastEventAt > best.incident.lastEventAt)) {
			best = { incident, reasons };
		}
	}

	if (!best && !notable) return { isNew: false };

	const isNew = !best;
	const incident: Incident = best
		? best.incident
		: {
				id: nextIncidentId(state),
				title: e.summary.slice(0, LIMITS.summaryChars),
				status: "open",
				severity: e.severity,
				createdAt: e.createdAt,
				updatedAt: e.createdAt,
				lastEventAt: e.createdAt,
				eventCount: 0,
				originSources: [],
				actorIds: [],
				pluginIds: [],
				resourceKeys: [],
				resourceLabels: [],
				protectedResourceKeys: [],
				domains: [],
				reasons: [],
				highEventCount: 0,
				originKeys: [],
				highProtectedKeys: [],
				...(e.resourceKey ? { primaryResourceKey: e.resourceKey } : {}),
			};
	const previousSeverity = isNew ? undefined : incident.severity;

	incident.eventCount += 1;
	incident.updatedAt = e.createdAt;
	incident.lastEventAt = e.createdAt;
	addCapped(incident.originSources, e.attribution.source, 8);
	if (specific(e.originKey)) addCapped(incident.originKeys, e.originKey, LIMITS.incidentActors);
	addCapped(incident.actorIds, e.attribution.actorId, LIMITS.incidentActors);
	addCapped(incident.pluginIds, e.attribution.pluginId, LIMITS.incidentActors);
	addCapped(incident.resourceKeys, e.resourceKey, LIMITS.incidentResources);
	addCapped(incident.resourceLabels, e.resourceLabel, LIMITS.incidentResources);
	if (e.protectedResource) addCapped(incident.protectedResourceKeys, e.resourceKey, LIMITS.incidentResources);
	for (const d of e.domains) addCapped(incident.domains, d, LIMITS.incidentDomains);
	if (SEVERITY_RANK[e.severity] >= SEVERITY_RANK.high) incident.highEventCount += 1;
	if (isNew) addCapped(incident.reasons, `Opened by: ${e.trigger ?? e.summary}`.slice(0, 160), LIMITS.incidentReasons);
	for (const r of best?.reasons ?? []) addCapped(incident.reasons, r, LIMITS.incidentReasons);
	if (best) addCapped(incident.reasons, `Within ${Math.round(windowMs / 60_000)} min of the previous event`, LIMITS.incidentReasons);

	if (e.protectedResource && SEVERITY_RANK[e.severity] >= SEVERITY_RANK.high) addCapped(incident.highProtectedKeys, e.resourceKey, LIMITS.incidentResources);
	incident.severity = incidentSeverity({ ...incident, severity: maxSeverity(incident.severity, e.severity) });

	if (isNew) state.incidents.push(incident);
	return { incident, isNew, ...(previousSeverity ? { previousSeverity } : {}) };
}
