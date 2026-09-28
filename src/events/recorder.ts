import type { Config } from "../core/config";
import { LIMITS } from "../core/limits";
import type { Store } from "../core/store";
import type { Attribution, Category, ResourceState, Signal } from "../core/types";
import { isRecord } from "../core/validate";
import { compareToBaseline } from "../integrity/baseline";
import { fingerprint } from "../integrity/hash";
import { classifyChange, markersOf, snapshotFromStored, snapshotOf, storedRefs, type Analysis, type RefSnapshot } from "../intelligence/classify-change";
import { hostOf } from "../intelligence/domains";
import { extract, type Extraction } from "../intelligence/urls";
import { viaPhrase } from "./origin";
import { applyToState, commitState, persistOutcome, resourceKeyOf, type DraftEvent } from "./pipeline";
import { findPendingAttribution, type ActionClass, type PendingAttribution } from "./state";

export type ContentAction = "create" | "update" | "publish" | "unpublish" | "schedule" | "unschedule" | "trash" | "delete" | "restore";

const META: Record<ContentAction, { category: Category; action: string; cls: ActionClass; verb: string }> = {
	create: { category: "content", action: "content.created", cls: "edit", verb: "created" },
	update: { category: "content", action: "content.updated", cls: "edit", verb: "updated" },
	publish: { category: "publication", action: "publication.published", cls: "publish", verb: "published" },
	unpublish: { category: "publication", action: "publication.unpublished", cls: "unpublish", verb: "unpublished" },
	schedule: { category: "publication", action: "publication.scheduled", cls: "schedule", verb: "scheduled for publication" },
	unschedule: { category: "publication", action: "publication.unscheduled", cls: "unschedule", verb: "unscheduled" },
	trash: { category: "content", action: "content.trashed", cls: "delete", verb: "moved to trash" },
	delete: { category: "content", action: "content.deleted", cls: "delete", verb: "permanently deleted" },
	restore: { category: "content", action: "content.restored", cls: "restore", verb: "restored" },
};

export interface ContentChange {
	action: ContentAction;
	collection: string;
	resourceId: string;
	/** The full item from the hook event (`data`, `slug`, `status`, `liveData`…). */
	content?: Record<string, unknown>;
	attribution: Attribution;
	/** After-hooks carry no origin; inherit it from the matching policy decision. */
	inheritFrom?: PendingAttribution["action"];
}

export function titleOf(content: Record<string, unknown> | undefined): string | undefined {
	const data = isRecord(content?.data) ? content.data : undefined;
	for (const k of ["title", "name", "label", "heading"]) {
		const v = data?.[k];
		if (typeof v === "string" && v.trim()) return v.trim().slice(0, LIMITS.titleChars);
	}
	return undefined;
}

function str(v: unknown, max: number): string | undefined {
	return typeof v === "string" && v ? v.slice(0, max) : undefined;
}

export function displayLabel(resource: ResourceState | null, title: string | undefined, slug: string | undefined, key: string): string {
	return resource?.label ?? title ?? resource?.title ?? slug ?? resource?.slug ?? key;
}

/** Previous comparable state: our last observation, else the live data EmDash sent, else unknown. */
export function previousSnapshot(resource: ResourceState | null, content: Record<string, unknown> | undefined, siteHost?: string): RefSnapshot | null {
	if (resource?.lastRefs) return snapshotFromStored(resource.lastRefs, resource.lastUrlFields, resource.lastMarkers, siteHost);
	if (content && isRecord(content.liveData)) return snapshotOf(extract(content.liveData, siteHost));
	return null;
}

function attributionFor(change: ContentChange, pending: PendingAttribution | undefined): Attribution {
	if (!change.inheritFrom) return change.attribution;
	if (!pending) return { source: "unattributed" };
	const { action: _action, ...rest } = pending;
	return { ...rest, inherited: true };
}

/**
 * Record one content lifecycle change. Budget: config 1, resource 1, state 2 (+2 on conflict),
 * event 1, resource 1, incident ≤1 → at most 9 bridge calls.
 */
export async function recordContentChange(store: Store, change: ContentChange, now = Date.now()): Promise<void> {
	const config = await store.config();
	const key = resourceKeyOf(change.collection, change.resourceId);
	const resource = await store.resource(key);
	const meta = META[change.action];
	const siteHost = hostOf(store.host.site.url);
	const content = change.content;
	const data = content && isRecord(content.data) ? content.data : undefined;
	const title = titleOf(content);
	const slug = str(content?.slug, LIMITS.slugChars);
	const status = str(content?.status, 32);
	const isProtected = resource?.isProtected === true;

	let extraction: Extraction | undefined;
	let fp: { hash: string; partial: boolean } | undefined;
	if (data) {
		extraction = extract(data, siteHost);
		fp = await fingerprint(content?.slug, data);
	}

	// Saves that change nothing (autosave, touch) are not new events.
	const unchanged = fp !== undefined && resource?.lastHash === fp.hash && (change.action === "update" || change.action === "create") && resource.lastStatus === status;

	const outcome = unchanged
		? undefined
		: await commitState(store, (state) => {
				const pending = change.inheritFrom ? findPendingAttribution(state, key, change.inheritFrom, now) : undefined;
				const attribution = attributionFor(change, pending);
				const signals: Signal[] = [];
				let analysis: Analysis | undefined;
				if (extraction) {
					const before = previousSnapshot(resource, content, siteHost);
					const firstSeen = before === null && change.action !== "create";
					analysis = classifyChange(before, extraction, {
						trusted: config.trustedDomains,
						blocked: config.blockedDomains,
						observed: new Set(Object.keys(state.observed)),
						firstSeen,
					});
					signals.push(...analysis.signals);
				}
				if (fp && resource?.baseline && extraction) {
					const drift = compareToBaseline(resource.baseline, { hash: fp.hash, hosts: analysis?.hosts ?? [] });
					const wasMatching = resource.lastHash === undefined || resource.lastHash === resource.baseline.hash;
					const newlyAdded = drift.domainsAdded.filter((h) => analysis?.introducedDomains.some((d) => d.host === h));
					if (drift.changed && (wasMatching || newlyAdded.length > 0)) {
						signals.push({ code: "integrity.drift", detail: drift.domainsAdded.length ? `new vs baseline: ${drift.domainsAdded.slice(0, 3).join(", ")}` : "differs from baseline" });
					} else if (!drift.hashChanged && resource.lastHash !== resource.baseline.hash) {
						signals.push({ code: "integrity.match", detail: "matches baseline again" });
					}
				}
				const label = displayLabel(resource, title, slug, key);
				const top = signals.find((s) => s.code !== "analysis.partial" && s.code !== "analysis.first-seen" && s.code !== "domain.removed");
				const draft: DraftEvent = {
					category: meta.category,
					action: meta.action,
					actionClass: meta.cls,
					summary: `${isProtected ? "Protected " : ""}"${label}" ${meta.verb} ${viaPhrase(attribution)}${top ? `; ${describeSignal(top)}` : ""}`,
					attribution,
					signals,
					protectedResource: isProtected,
					collection: change.collection,
					resourceId: change.resourceId,
					...(title ? { resourceTitle: title } : {}),
					...(slug ? { resourceSlug: slug } : {}),
					...(resource?.lastHash ? { previousHash: resource.lastHash } : {}),
					...(fp ? { currentHash: fp.hash } : {}),
					domains: analysis?.introducedDomains.map((d) => d.host) ?? [],
					...(analysis?.partial || fp?.partial ? { partial: true } : {}),
				};
				return applyToState(state, draft, config, now);
			});

	if (outcome) await persistOutcome(store, outcome, 1);

	if (store.budget.has(1)) {
		const next = nextResourceState(resource, change, key, now, { title, slug, status, fp: fp?.hash, extraction });
		await store.observeResource(next, observationFields(next));
	}
}

export function nextResourceState(
	prev: ResourceState | null,
	change: Pick<ContentChange, "action" | "collection" | "resourceId">,
	key: string,
	now: number,
	obs: { title?: string | undefined; slug?: string | undefined; status?: string | undefined; fp?: string | undefined; extraction?: Extraction | undefined },
): ResourceState {
	const iso = new Date(now).toISOString();
	const next: ResourceState = {
		...(prev ?? { key, collection: change.collection, resourceId: change.resourceId, isProtected: false }),
		key,
		collection: change.collection,
		resourceId: change.resourceId,
		lastSeenAt: iso,
		updatedAt: iso,
	};
	if (obs.title) next.title = obs.title;
	if (obs.slug) next.slug = obs.slug;
	if (obs.status) next.lastStatus = obs.status;
	if (obs.fp) next.lastHash = obs.fp;
	if (obs.extraction) {
		next.lastRefs = storedRefs(obs.extraction);
		next.lastUrlFields = { ...obs.extraction.urlFields };
		next.lastMarkers = markersOf(obs.extraction);
	}
	if (change.action === "trash" || change.action === "delete") next.deleted = true;
	else if (change.action === "restore" || change.action === "create") next.deleted = false;
	return next;
}

const OBSERVED_KEYS = ["title", "slug", "lastStatus", "lastHash", "lastRefs", "lastUrlFields", "lastMarkers", "deleted", "lastSeenAt", "updatedAt"] as const;

/** The subset of a resource record that hooks own. */
export function observationFields(r: ResourceState): Partial<ResourceState> {
	const out: Record<string, unknown> = {};
	for (const k of OBSERVED_KEYS) if (r[k] !== undefined) out[k] = r[k];
	return out as Partial<ResourceState>;
}

const SIGNAL_TEXT: Partial<Record<Signal["code"], string>> = {
	"domain.new": "new external domain",
	"domain.observed": "previously observed domain added",
	"domain.trusted": "trusted domain added",
	"domain.blocked": "blocked domain introduced",
	"domain.punycode": "punycode domain",
	"domain.ip": "IP-address link",
	"url.http": "insecure http:// link",
	"url.javascript": "javascript: URL introduced",
	"url.data": "data: URL introduced",
	"url.changed": "URL destination changed",
	"embed.script": "external script reference introduced",
	"embed.inline-script": "inline script introduced",
	"embed.iframe": "iframe introduced",
	"embed.object": "embedded object introduced",
	"embed.form": "form target introduced",
	"embed.handler": "inline event handler introduced",
	"embed.block": "embed block added",
	"links.many": "many outbound links added",
	"integrity.drift": "drifted from known good state",
	"integrity.match": "matches known good state",
};

export function describeSignal(s: Signal): string {
	const text = SIGNAL_TEXT[s.code] ?? s.code;
	return s.detail ? `${text} (${s.detail})` : text;
}
