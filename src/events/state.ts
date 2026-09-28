import { ATTRIBUTION_WINDOW_MS, LIMITS } from "../core/limits";
import type { Incident, OriginSource, Severity } from "../core/types";
import { isRecord } from "../core/validate";

export type ActionClass = "edit" | "publish" | "unpublish" | "schedule" | "unschedule" | "delete" | "restore" | "media" | "redirect" | "policy";

/** One compact line of recent activity. Short keys keep the KV value small. */
export interface RingEntry {
	/** epoch ms */
	t: number;
	/** resource key */
	k?: string;
	/** origin key (source:actor) */
	o: string;
	/** action class */
	a: ActionClass;
	/** severity rank */
	v: number;
	/** protected */
	p?: 1;
	/** introduced domains (max 3) */
	d?: string[];
	/** policy decision awaiting its after-hook: attribution to inherit */
	pol?: PendingAttribution;
}

export interface PendingAttribution {
	action: "publish" | "schedule" | "unpublish";
	source: OriginSource;
	rawSource?: string;
	pluginId?: string;
	actorId?: string;
	actorRole?: number;
	actorSource?: string;
}

export interface PendingAlert {
	incidentId: string;
	severity: Severity;
	title: string;
	at: number;
}

/** The single KV record every hook reads once and writes once (compare-and-set). */
export interface ActivityState {
	v: 1;
	ring: RingEntry[];
	/** Recent open incidents, the only correlation candidates. */
	incidents: Incident[];
	/** Observed external hosts → last seen (epoch ms). */
	observed: Record<string, number>;
	/** Last bulk-activity event per origin key (epoch ms), to emit one per window. */
	bulk: Record<string, number>;
	alerts: { pending: PendingAlert[]; lastSentAt?: number };
	seq: number;
}

export const STATE_KEY = "state";

export function emptyState(): ActivityState {
	return { v: 1, ring: [], incidents: [], observed: {}, bulk: {}, alerts: { pending: [] }, seq: 1000 };
}

/** Tolerant read: anything malformed is dropped rather than trusted. */
export function parseState(raw: unknown): ActivityState {
	const s = emptyState();
	if (!isRecord(raw) || raw.v !== 1) return s;
	if (Array.isArray(raw.ring)) s.ring = raw.ring.filter((e): e is RingEntry => isRecord(e) && typeof e.t === "number" && typeof e.o === "string" && typeof e.a === "string");
	if (Array.isArray(raw.incidents)) s.incidents = raw.incidents.filter(isRecord).map(normalizeIncident).filter((i): i is Incident => i !== undefined);
	if (isRecord(raw.observed)) for (const [k, v] of Object.entries(raw.observed)) if (typeof v === "number") s.observed[k] = v;
	if (isRecord(raw.bulk)) for (const [k, v] of Object.entries(raw.bulk)) if (typeof v === "number") s.bulk[k] = v;
	if (isRecord(raw.alerts)) {
		if (Array.isArray(raw.alerts.pending)) s.alerts.pending = raw.alerts.pending.filter((p): p is PendingAlert => isRecord(p) && typeof p.incidentId === "string");
		if (typeof raw.alerts.lastSentAt === "number") s.alerts.lastSentAt = raw.alerts.lastSentAt;
	}
	if (typeof raw.seq === "number" && Number.isSafeInteger(raw.seq)) s.seq = raw.seq;
	return s;
}

const INCIDENT_ARRAYS = ["originSources", "actorIds", "pluginIds", "resourceKeys", "resourceLabels", "protectedResourceKeys", "domains", "reasons", "originKeys", "highProtectedKeys"] as const;

/** Cached incidents from older versions or corrupted state get every list field defaulted. */
function normalizeIncident(raw: Record<string, unknown>): Incident | undefined {
	if (typeof raw.id !== "string" || typeof raw.lastEventAt !== "string") return undefined;
	const i = { ...raw } as Record<string, unknown>;
	for (const k of INCIDENT_ARRAYS) if (!Array.isArray(i[k])) i[k] = [];
	if (typeof i.eventCount !== "number") i.eventCount = 0;
	if (typeof i.highEventCount !== "number") i.highEventCount = 0;
	if (typeof i.severity !== "string") i.severity = "info";
	if (typeof i.status !== "string") i.status = "open";
	return i as unknown as Incident;
}

/** Drop expired and excess entries so the record stays bounded. */
export function prune(state: ActivityState, now: number, correlationWindowMs: number): void {
	const cutoff = now - LIMITS.ringWindowMs;
	state.ring = state.ring.filter((e) => e.t >= cutoff).slice(-LIMITS.ringEntries);
	state.incidents = state.incidents
		.filter((i) => Date.parse(i.lastEventAt) >= now - correlationWindowMs && (i.status === "open" || i.status === "investigating"))
		.slice(-LIMITS.cachedIncidents);
	for (const [k, t] of Object.entries(state.bulk)) if (t < now - LIMITS.ringWindowMs) delete state.bulk[k];
	const hosts = Object.entries(state.observed);
	if (hosts.length > LIMITS.observedDomains) {
		hosts.sort((a, b) => b[1] - a[1]);
		state.observed = Object.fromEntries(hosts.slice(0, LIMITS.observedDomains));
	}
	state.alerts.pending = state.alerts.pending.slice(-LIMITS.pendingAlerts);
}

/** Most recent policy decision for this resource and action within the attribution window. */
export function findPendingAttribution(state: ActivityState, key: string, action: PendingAttribution["action"], now: number): PendingAttribution | undefined {
	for (let i = state.ring.length - 1; i >= 0; i -= 1) {
		const e = state.ring[i];
		if (!e) continue;
		if (e.t < now - ATTRIBUTION_WINDOW_MS) break;
		if (e.k === key && e.pol && e.pol.action === action) return e.pol;
	}
	return undefined;
}

export function nextIncidentId(state: ActivityState): string {
	state.seq += 1;
	return `CW-${state.seq}`;
}
