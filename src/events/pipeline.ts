import type { Config } from "../core/config";
import { LIMITS } from "../core/limits";
import { SEVERITY_RANK, atLeast, eventSeverity } from "../core/severity";
import type { Store } from "../core/store";
import type { Attribution, Category, ChangeEvent, Incident, Severity, Signal } from "../core/types";
import { correlate, type CorrelationResult } from "../incidents/correlate";
import { detectBulk } from "../incidents/volume";
import { originKey, viaPhrase } from "./origin";
import { prune, type ActionClass, type ActivityState, type RingEntry } from "./state";

/** Sortable, unique event ID: time prefix + random suffix. */
export function newEventId(now: number): string {
	const rand = crypto.getRandomValues(new Uint8Array(6));
	let suffix = "";
	for (const b of rand) suffix += b.toString(36).padStart(2, "0");
	return `${now.toString(36).padStart(9, "0")}-${suffix}`;
}

export interface DraftEvent {
	category: Category;
	action: string;
	actionClass: ActionClass;
	summary: string;
	attribution: Attribution;
	signals: Signal[];
	protectedResource: boolean;
	collection?: string;
	resourceId?: string;
	resourceTitle?: string;
	resourceSlug?: string;
	previousHash?: string;
	currentHash?: string;
	domains?: string[];
	policy?: ChangeEvent["policy"];
	partial?: boolean;
	/** Overrides the computed severity (policy and bulk events). */
	severity?: Severity;
	/** Short explanation used when this event opens an incident. */
	trigger?: string;
	/** Correlation-only ring marker; not counted as a change. */
	pendingAttribution?: RingEntry["pol"];
	/** Do not persist the event (ring and correlation only). */
	ephemeral?: boolean;
}

export interface Outcome {
	events: ChangeEvent[];
	incidents: Array<{ incident: Incident; isNew: boolean }>;
	stateLost?: boolean;
}

export function resourceKeyOf(collection: string, id: string): string {
	return `${collection}:${id}`;
}

function toEvent(d: DraftEvent, now: number, severity: Severity): ChangeEvent {
	const a = d.attribution;
	const e: ChangeEvent = {
		id: newEventId(now),
		createdAt: new Date(now).toISOString(),
		category: d.category,
		action: d.action,
		severity,
		summary: d.summary.slice(0, LIMITS.summaryChars),
		originSource: a.source,
		protectedResource: d.protectedResource,
	};
	if (a.pluginId) e.originPluginId = a.pluginId;
	if (a.inherited) e.originInherited = true;
	if (a.actorId) e.actorId = a.actorId;
	if (a.actorRole !== undefined) e.actorRole = a.actorRole;
	if (a.actorSource) e.actorSource = a.actorSource;
	if (d.collection) e.collection = d.collection;
	if (d.resourceId) e.resourceId = d.resourceId;
	if (d.collection && d.resourceId) e.resourceKey = resourceKeyOf(d.collection, d.resourceId);
	if (d.resourceTitle) e.resourceTitle = d.resourceTitle.slice(0, LIMITS.titleChars);
	if (d.resourceSlug) e.resourceSlug = d.resourceSlug.slice(0, LIMITS.slugChars);
	if (d.previousHash) e.previousHash = d.previousHash;
	if (d.currentHash) e.currentHash = d.currentHash;
	if (d.signals.length) e.signals = d.signals.slice(0, LIMITS.eventSignals);
	if (d.domains?.length) e.domains = d.domains.slice(0, LIMITS.eventDomains);
	if (d.policy?.length) e.policy = d.policy.slice(0, LIMITS.eventPolicies);
	if (d.partial) e.partial = true;
	return e;
}

function label(d: DraftEvent): string | undefined {
	return d.resourceTitle ?? d.resourceSlug ?? (d.collection && d.resourceId ? resourceKeyOf(d.collection, d.resourceId) : undefined);
}

/**
 * Apply one draft event (plus a derived bulk-activity event when a volume threshold trips) to the
 * activity state. Pure with respect to storage; mutates `state`.
 */
export function applyToState(state: ActivityState, draft: DraftEvent, config: Config, now: number): Outcome {
	const windowMs = config.correlationWindowMin * 60_000;
	prune(state, now, windowMs);
	const outcome: Outcome = { events: [], incidents: [] };
	const a = draft.attribution;
	const oKey = originKey(a);
	const severity = draft.severity ?? eventSeverity({ signals: draft.signals, protectedResource: draft.protectedResource, origin: a.source, action: draft.actionClass });
	const key = draft.collection && draft.resourceId ? resourceKeyOf(draft.collection, draft.resourceId) : undefined;

	const entry: RingEntry = { t: now, o: oKey, a: draft.pendingAttribution ? "policy" : draft.actionClass, v: SEVERITY_RANK[severity] };
	if (key) entry.k = key;
	if (draft.protectedResource) entry.p = 1;
	const introduced = draft.domains ?? [];
	if (introduced.length) entry.d = introduced.slice(0, 3);
	if (draft.pendingAttribution) entry.pol = draft.pendingAttribution;
	state.ring.push(entry);
	for (const host of introduced) state.observed[host] = now;

	const drafts: Array<{ d: DraftEvent; severity: Severity }> = [];
	if (!draft.ephemeral) drafts.push({ d: draft, severity });

	const bulk = draft.pendingAttribution ? undefined : detectBulk(state, entry, config.volume, now);
	if (bulk) {
		drafts.push({
			severity: draft.protectedResource ? "high" : "medium",
			d: {
				category: "activity",
				action: "activity.bulk",
				actionClass: "edit",
				summary: `Unusual change volume ${viaPhrase(a)}: ${bulk.detail}`,
				attribution: a,
				signals: [{ code: "volume.bulk", detail: bulk.detail }],
				protectedResource: draft.protectedResource,
				trigger: `Unusual change volume (${bulk.detail})`,
			},
		});
	}

	for (const { d, severity: sev } of drafts) {
		const event = toEvent(d, now, sev);
		const result: CorrelationResult = correlate(
			state,
			{
				createdAt: event.createdAt,
				...(event.resourceKey ? { resourceKey: event.resourceKey } : {}),
				...(label(d) ? { resourceLabel: label(d) } : {}),
				originKey: oKey,
				attribution: a,
				domains: introduced,
				severity: sev,
				protectedResource: d.protectedResource,
				summary: event.summary,
				...(d.trigger ? { trigger: d.trigger } : {}),
			},
			windowMs,
		);
		if (result.incident) {
			event.incidentId = result.incident.id;
			const existing = outcome.incidents.find((x) => x.incident.id === result.incident?.id);
			if (existing) existing.incident = result.incident;
			else outcome.incidents.push({ incident: result.incident, isNew: result.isNew });
			queueAlert(state, config, result, now);
		}
		outcome.events.push(event);
	}
	return outcome;
}

function queueAlert(state: ActivityState, config: Config, r: CorrelationResult, now: number): void {
	const i = r.incident;
	if (!i || !config.alerts.enabled || !config.alerts.email) return;
	const crossed = atLeast(i.severity, config.alerts.minSeverity) && (r.isNew || !r.previousSeverity || !atLeast(r.previousSeverity, config.alerts.minSeverity));
	if (!crossed) return;
	state.alerts.pending = state.alerts.pending.filter((p) => p.incidentId !== i.id);
	state.alerts.pending.push({ incidentId: i.id, severity: i.severity, title: i.title, at: now });
}

/**
 * Read the activity state, apply `mutate`, and compare-and-set it back. On a conflict the state is
 * re-read and `mutate` re-run once (it must be a pure function of the state). A second conflict
 * gives up on the state update rather than looping; the caller still writes its event.
 */
export async function commitState<T extends { stateLost?: boolean }>(store: Store, mutate: (state: ActivityState) => T, retry = true): Promise<T> {
	let { state, revision } = await store.state();
	let result = mutate(state);
	if (await store.saveState(state, revision)) return result;
	if (!retry || !store.budget.has(5)) return { ...result, stateLost: true };
	({ state, revision } = await store.state());
	result = mutate(state);
	if (await store.saveState(state, revision)) return result;
	return { ...result, stateLost: true };
}

/** Persist events and touched incidents within the remaining budget, events first. */
export async function persistOutcome(store: Store, outcome: Outcome, reserve = 0): Promise<void> {
	if (outcome.stateLost) {
		// The incident IDs came from an unsaved sequence; writing them could overwrite a later
		// incident with the same ID. Keep the events, drop the links.
		for (const e of outcome.events) delete e.incidentId;
		await store.putEvents(outcome.events);
		return;
	}
	await store.putEvents(outcome.events);
	for (const { incident, isNew } of outcome.incidents) {
		if (!store.budget.has(1 + reserve)) break;
		if (isNew) await store.putIncident(incident);
		else if (!(await store.mergeOpenIncident(incident))) {
			// The administrator closed it after it was cached; the event keeps its reference.
		}
	}
}
