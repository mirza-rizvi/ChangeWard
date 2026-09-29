import { LIMITS } from "../core/limits";
import type { Store } from "../core/store";
import { INCIDENT_STATUSES, type ChangeEvent, type Incident, type IncidentStatus } from "../core/types";
import { ORIGIN_LABELS } from "../events/origin";
import { commitState } from "../events/pipeline";
import { EVENT_COLUMNS, INCIDENT_COLUMNS, SEVERITY_LABEL, bullets, eventRow, utc, incidentRow, page, type Block, type BlockResponse } from "./ui";

/** Allowed manual transitions. Changing status only affects ChangeWard's records, never content. */
export const TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
	open: ["investigating", "resolved", "ignored"],
	investigating: ["open", "resolved", "ignored"],
	resolved: ["open"],
	ignored: ["open"],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

const STATUS_FILTERS = [
	{ label: "Open and investigating", value: "active" },
	{ label: "Open", value: "open" },
	{ label: "Investigating", value: "investigating" },
	{ label: "Resolved", value: "resolved" },
	{ label: "Ignored", value: "ignored" },
	{ label: "All", value: "all" },
];

function statusWhere(filter: string): Record<string, unknown> {
	if (filter === "active") return { status: { in: ["open", "investigating"] } };
	if ((INCIDENT_STATUSES as readonly string[]).includes(filter)) return { status: filter };
	return {};
}

function rowMenu(i: Incident): Record<string, unknown> {
	const items = [{ label: "View timeline", value: `view|${i.id}` }, ...TRANSITIONS[i.status].map((to) => ({ label: `Mark ${to}`, value: `status|${i.id}|${to}` }))];
	return { actions: { type: "menu", action_id: "incidents:row", label: "Actions", items } };
}

/** Budget: 1 query. */
export async function incidentsPage(store: Store, filter = "active", cursor?: string, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
	const f = STATUS_FILTERS.some((s) => s.value === filter) ? filter : "active";
	const res = await store.queryIncidents(statusWhere(f), LIMITS.pageSize, cursor);
	const blocks: Block[] = [
		{
			type: "section",
			text: "An incident groups related changes: the same resource, the same origin and actor, or a shared domain within the correlation window. It is a review aid, not a verdict.",
		},
		{
			type: "form",
			block_id: "incidents:filter",
			fields: [{ type: "select", action_id: "status", label: "Status", options: STATUS_FILTERS, initial_value: f }],
			submit: { label: "Apply", action_id: "incidents:filter" },
		},
		{
			type: "table",
			block_id: `incidents:f:${f}`,
			columns: [...INCIDENT_COLUMNS, { key: "actions", label: "", format: "element" }],
			rows: res.items.map((x) => ({ ...incidentRow(x.data as Incident), ...rowMenu(x.data as Incident) })),
			page_action_id: "incidents:page",
			...(res.hasMore && res.cursor ? { next_cursor: res.cursor } : {}),
			empty_text: "No incidents in this view.",
		},
	];
	return page("/incidents", "Incidents", blocks, toast);
}

/** Budget: incident 1 + timeline query 1. */
export async function incidentDetail(store: Store, id: string, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
	const incident = await store.incident(id);
	if (!incident) return incidentsPage(store, "active", undefined, { type: "error", message: `Incident ${id} not found.` });
	const timeline = await store.queryEvents({ incidentId: id }, 50);
	const events = timeline.items.map((x) => x.data as ChangeEvent).reverse();
	const blocks: Block[] = [
		{ type: "section", text: incident.title },
		{
			type: "fields",
			fields: [
				{ label: "Incident", value: incident.id },
				{ label: "Severity", value: SEVERITY_LABEL[incident.severity] },
				{ label: "Status", value: incident.status[0]?.toUpperCase() + incident.status.slice(1) },
				{ label: "Opened", value: utc(incident.createdAt) },
				{ label: "Last activity", value: utc(incident.lastEventAt) },
				{ label: "Events", value: String(incident.eventCount) },
				{ label: "Origins", value: incident.originSources.map((s) => ORIGIN_LABELS[s] ?? s).join(", ") || "—" },
				{ label: "Actors", value: incident.actorIds.join(", ") || "Not reported" },
				{ label: "Plugins", value: incident.pluginIds.join(", ") || "—" },
				{ label: "Affected resources", value: `${incident.resourceKeys.length} (${incident.protectedResourceKeys.length} protected)` },
				{ label: "Domains", value: incident.domains.join(", ") || "—" },
			],
		},
		{ type: "header", text: "Why these events are grouped" },
		...bullets(incident.reasons),
		{ type: "header", text: "Timeline" },
		{
			type: "table",
			block_id: `incident:${incident.id}`,
			columns: EVENT_COLUMNS,
			rows: events.map((e) => eventRow(e)),
			page_action_id: "incidents:noop",
			empty_text: "Timeline events have expired under the retention policy; the incident summary is kept.",
		},
		{
			type: "actions",
			elements: [
				...TRANSITIONS[incident.status].map((to) => ({
					type: "button" as const,
					label: `Mark ${to}`,
					action_id: "incidents:status",
					value: `${incident.id}|${to}`,
					...(to === "resolved" ? { style: "primary" as const } : {}),
				})),
				{ type: "button" as const, label: "Back to incidents", action_id: "incidents:back" },
			],
		},
		{ type: "context", text: "Status changes only affect ChangeWard's records. They never modify content." },
	];
	if (timeline.hasMore) blocks.push({ type: "context", text: "Showing the most recent 50 events." });
	return page("/incidents", `Incident ${incident.id}`, blocks, toast);
}

/**
 * Budget: incident 1, guarded update 1, state 2 (+2), detail 2. The guarded update compares the
 * status the administrator saw, so concurrent changes are rejected instead of overwritten.
 */
export async function changeIncidentStatus(store: Store, id: string, to: IncidentStatus, userId: string | undefined, now = Date.now()): Promise<BlockResponse> {
	const incident = await store.incident(id);
	if (!incident) return incidentsPage(store, "active", undefined, { type: "error", message: `Incident ${id} not found.` });
	if (!canTransition(incident.status, to)) {
		return incidentDetail(store, id, { type: "error", message: `Cannot change ${incident.status} to ${to}.` });
	}
	const iso = new Date(now).toISOString();
	const applied = await store.updateIncidentStatus(id, incident.status, {
		status: to,
		statusChangedAt: iso,
		updatedAt: iso,
		...(userId ? { statusChangedBy: userId } : {}),
	});
	if (!applied) return incidentDetail(store, id, { type: "error", message: "The incident changed in the meantime. Review it and try again." });
	// Keep the correlation cache in step so new activity opens a fresh incident.
	await commitState(store, (state) => {
		const cached = state.incidents.find((i) => i.id === id);
		if (cached) {
			if (to === "resolved" || to === "ignored") state.incidents = state.incidents.filter((i) => i.id !== id);
			else cached.status = to;
		}
		return {};
	});
	return incidentDetail(store, id, { type: "success", message: `${id} marked ${to}.` });
}
