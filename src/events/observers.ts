import { LIMITS } from "../core/limits";
import type { Store } from "../core/store";
import { isRecord } from "../core/validate";
import { hostOf } from "../intelligence/domains";
import { mediaSignals } from "../intelligence/media";
import { diffRedirects, parseRule, type RedirectRule, type RedirectSnapshot } from "../intelligence/redirects";
import { applyToState, commitState, persistOutcome, type DraftEvent, type Outcome } from "./pipeline";

/** `media:afterUpload`. Budget: config 1, state 2 (+2), event 1, incident ≤1. */
export async function recordMediaUpload(store: Store, media: unknown, now = Date.now()): Promise<void> {
	if (!isRecord(media)) return;
	const config = await store.config();
	if (!config.mediaMonitoring) return;
	const filename = typeof media.filename === "string" ? media.filename.slice(0, 200) : "";
	const mimeType = typeof media.mimeType === "string" ? media.mimeType.slice(0, 100) : "";
	const id = typeof media.id === "string" ? media.id.slice(0, LIMITS.idChars) : "";
	const signals = mediaSignals(filename, mimeType);
	const draft: DraftEvent = {
		category: "media",
		action: "media.uploaded",
		actionClass: "media",
		summary: `Media "${filename}" uploaded (origin not reported)${signals[0] ? `; ${signals.map((s) => s.code.replace("media.", "")).join(", ")}` : ""}`,
		attribution: { source: "unattributed" },
		signals,
		protectedResource: false,
		collection: "media",
		resourceId: id,
		resourceTitle: filename,
	};
	const outcome = await commitState(store, (state) => applyToState(state, draft, config, now));
	await persistOutcome(store, outcome);
}

export const REDIRECT_SNAPSHOT_KEY = "redirects:snapshot";

/**
 * Cron: compare the current redirect rules with the previous snapshot. There is no redirect hook,
 * so changes are observed as net differences and attributed to no origin. Covers the first
 * `redirectPages × redirectPageSize` rules; beyond that the snapshot is marked partial.
 * Budget: config 1, snapshot 1, list ≤2, state 2, event 1, snapshot 1, incident ≤1 → 9.
 */
export async function scanRedirects(store: Store, now = Date.now()): Promise<{ changes: number; partial: boolean } | undefined> {
	const redirects = store.host.redirects;
	if (!redirects) return undefined;
	const config = await store.config();
	if (!config.redirectMonitoring) return undefined;
	const prev = await store.kvGet<RedirectSnapshot>(REDIRECT_SNAPSHOT_KEY);

	const rules: RedirectRule[] = [];
	let cursor: string | undefined;
	let partial = false;
	for (let page = 0; page < LIMITS.redirectPages; page += 1) {
		const res = await store.budget.call(() => redirects.list({ limit: LIMITS.redirectPageSize, ...(cursor ? { cursor } : {}) }));
		for (const raw of res.items) {
			const r = parseRule(raw);
			if (r) rules.push(r);
		}
		cursor = res.cursor;
		if (!cursor || res.hasMore === false) break;
		if (page === LIMITS.redirectPages - 1) partial = true;
	}
	const next: RedirectSnapshot = { takenAt: new Date(now).toISOString(), rules, partial };

	if (prev && Array.isArray(prev.rules)) {
		const changes = diffRedirects(prev, next, hostOf(store.host.site.url), config.blockedDomains).slice(0, 25);
		if (changes.length) {
			const outcome = await commitState(
				store,
				(state) => {
					const merged: Outcome = { events: [], incidents: [] };
					changes.forEach((c, i) => {
						const verb = c.kind === "added" ? "added" : c.kind === "removed" ? "removed" : "changed";
						const draft: DraftEvent = {
							category: "redirect",
							action: `redirect.${verb}`,
							actionClass: "redirect",
							summary: `Redirect ${c.rule.source} ${verb} (observed by periodic check)${c.host ? `; destination ${c.host}` : ""}`,
							attribution: { source: "unattributed" },
							signals: partial ? [...c.signals, { code: "redirect.partial" }] : c.signals,
							protectedResource: false,
							collection: "redirects",
							resourceId: c.rule.id,
							resourceTitle: c.rule.source,
							...(c.host ? { domains: [c.host] } : {}),
						};
						// Spread timestamps by 1 ms so events sort deterministically.
						const o = applyToState(state, draft, config, now + i);
						merged.events.push(...o.events);
						for (const inc of o.incidents) {
							const existing = merged.incidents.find((x) => x.incident.id === inc.incident.id);
							if (existing) existing.incident = inc.incident;
							else merged.incidents.push(inc);
						}
					});
					return merged;
				},
				false,
			);
			await store.putEvents(outcome.events);
			await store.kvSet(REDIRECT_SNAPSHOT_KEY, next);
			await persistOutcome(store, { events: [], incidents: outcome.incidents });
			return { changes: changes.length, partial };
		}
	}
	await store.kvSet(REDIRECT_SNAPSHOT_KEY, next);
	return { changes: 0, partial };
}
