import { CATEGORIES, ORIGIN_SOURCES, type ChangeEvent } from "../core/types";
import type { Store, Where } from "../core/store";
import { LIMITS } from "../core/limits";
import { ORIGIN_LABELS } from "../events/origin";
import { describeSignal } from "../events/recorder";
import { shortHash } from "../integrity/hash";
import { EVENT_COLUMNS, SEVERITY_LABEL, bullets, eventRow, origin, page, resourceText, utc, type Block, type BlockResponse } from "./ui";

/** One indexed filter at a time: every option maps to exactly one declared storage index. */
export function filterWhere(filter: string): Where | undefined {
	if (filter === "all") return {};
	if (filter === "protected") return { protectedResource: true };
	if (filter === "important") return { severity: { in: ["high", "critical"] } };
	const [kind, ...rest] = filter.split(":");
	const arg = rest.join(":");
	if (kind === "origin" && (ORIGIN_SOURCES as readonly string[]).includes(arg)) return { originSource: arg };
	if (kind === "category" && (CATEGORIES as readonly string[]).includes(arg)) return { category: arg };
	if (kind === "resource" && /^[A-Za-z0-9_.-]{1,100}:[A-Za-z0-9_.-]{1,200}$/.test(arg)) return { resourceKey: arg };
	return undefined;
}

const FILTER_OPTIONS: Array<{ label: string; value: string }> = [
	{ label: "All activity", value: "all" },
	...(["mcp", "api", "plugin", "scheduler", "visual-editor", "system", "unattributed"] as const).map((s) => ({ label: s === "unattributed" ? "Origin not reported" : `Origin: ${ORIGIN_LABELS[s]}`, value: `origin:${s}` })),
	{ label: "Protected resources", value: "protected" },
	{ label: "High severity", value: "important" },
	{ label: "Policy decisions", value: "category:policy" },
	{ label: "Publication", value: "category:publication" },
	{ label: "Content", value: "category:content" },
	{ label: "Bulk activity", value: "category:activity" },
	{ label: "Redirects", value: "category:redirect" },
	{ label: "Media", value: "category:media" },
	{ label: "ChangeWard configuration", value: "category:system" },
];

function rowActions(e: ChangeEvent): Record<string, unknown> {
	const items: Array<{ label: string; value: string }> = [{ label: "Details", value: `detail|${e.id}` }];
	if (e.incidentId) items.push({ label: `View incident ${e.incidentId}`, value: `incident|${e.incidentId}` });
	if (e.resourceKey && e.collection !== "media" && e.collection !== "redirects") {
		items.push({ label: "Resource history", value: `history|${e.resourceKey}` });
		if (!e.protectedResource) items.push({ label: "Protect this resource", value: `protect|${e.resourceKey}` });
	}
	return { actions: { type: "menu", action_id: "activity:row", label: "Actions", items } };
}

/** Budget: 1 query. */
export async function activityPage(store: Store, filter = "all", cursor?: string, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
	const where = filterWhere(filter) ?? {};
	const res = await store.queryEvents(where, LIMITS.pageSize, cursor);
	const label = FILTER_OPTIONS.find((o) => o.value === filter)?.label ?? (filter.startsWith("resource:") ? `Resource ${filter.slice(9)}` : "All activity");
	const blocks: Block[] = [
		{
			type: "form",
			block_id: "activity:filter",
			fields: [{ type: "select", action_id: "filter", label: "Show", options: FILTER_OPTIONS, initial_value: FILTER_OPTIONS.some((o) => o.value === filter) ? filter : "all" }],
			submit: { label: "Apply", action_id: "activity:filter" },
		},
		{ type: "context", text: `${label}${cursor ? " (next page)" : ""}. Newest first.` },
		{
			type: "table",
			block_id: `activity:f:${filter}`,
			columns: [...EVENT_COLUMNS, { key: "actions", label: "", format: "element" }],
			rows: res.items.map((x) => eventRow(x.data as ChangeEvent, rowActions(x.data as ChangeEvent))),
			page_action_id: "activity:page",
			...(res.hasMore && res.cursor ? { next_cursor: res.cursor } : {}),
			empty_text: "No activity recorded for this view yet.",
		},
	];
	if (cursor) blocks.push({ type: "actions", elements: [{ type: "button", label: "Back to newest", action_id: "activity:first", value: filter }] });
	return page("/activity", "Activity", blocks, toast);
}

export function eventDetail(e: ChangeEvent): Block[] {
	const fields = [
		{ label: "When", value: utc(e.createdAt) },
		{ label: "Action", value: e.action },
		{ label: "Severity", value: SEVERITY_LABEL[e.severity] },
		{ label: "Origin", value: origin(e) },
		{ label: "Actor", value: e.actorId ? `${e.actorId}${e.actorRole !== undefined ? ` (role ${e.actorRole})` : ""}` : "Not reported" },
		{ label: "Resource", value: resourceText(e) },
		{ label: "Collection / ID", value: e.collection && e.resourceId ? `${e.collection} / ${e.resourceId}` : "—" },
		{ label: "Fingerprint", value: `${shortHash(e.previousHash)} → ${shortHash(e.currentHash)}` },
	];
	if (e.incidentId) fields.push({ label: "Incident", value: e.incidentId });
	const blocks: Block[] = [{ type: "section", text: e.summary }, { type: "fields", fields }];
	if (e.signals?.length) {
		blocks.push({ type: "header", text: "Change intelligence" });
		blocks.push(...bullets(e.signals.map((s) => describeSignal(s))));
	}
	if (e.policy?.length) {
		blocks.push({ type: "header", text: "Policy results" });
		blocks.push(...bullets(e.policy.map((p) => `${p.rule}: ${p.result.toUpperCase()}. ${p.reason}`)));
	}
	if (e.partial) blocks.push({ type: "context", text: "Analysis was partial: the content exceeded ChangeWard's per-change processing limits." });
	if (e.originInherited) blocks.push({ type: "context", text: "Origin taken from the publication-policy check that preceded this action." });
	if (e.collection && e.resourceId && e.collection !== "media" && e.collection !== "redirects") {
		blocks.push({ type: "actions", elements: [{ type: "link", label: "Open entry", target: { kind: "content", collection: e.collection, id: e.resourceId } }] });
	}
	return blocks;
}
