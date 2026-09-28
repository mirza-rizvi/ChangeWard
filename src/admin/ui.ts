import type { Block, BlockResponse, TableColumn } from "@emdash-cms/blocks";
import type { ChangeEvent, Incident, Severity } from "../core/types";
import { ORIGIN_LABELS } from "../events/origin";

export type { Block, BlockResponse };

export const SEVERITY_LABEL: Record<Severity, string> = { info: "Info", low: "Low", medium: "Medium", high: "High", critical: "Critical" };

export function nav(active: string): Block {
	const pages: Array<[string, string]> = [
		["/overview", "Overview"],
		["/activity", "Activity"],
		["/incidents", "Incidents"],
		["/protected", "Protected"],
		["/policies", "Policies"],
		["/settings", "Settings"],
	];
	return {
		type: "actions",
		elements: pages.map(([path, label]) => ({
			type: "link" as const,
			label,
			target: { kind: "plugin-page" as const, path },
			appearance: path === active ? ("primary" as const) : ("secondary" as const),
		})),
	};
}

export function page(active: string, title: string, blocks: Block[], toast?: BlockResponse["toast"]): BlockResponse {
	return { blocks: [{ type: "header", text: title }, nav(active), ...blocks], ...(toast ? { toast } : {}) };
}

export function origin(e: Pick<ChangeEvent, "originSource" | "originPluginId" | "originInherited">): string {
	const base = e.originSource === "plugin" && e.originPluginId ? `Plugin ${e.originPluginId}` : ORIGIN_LABELS[e.originSource] ?? "Unknown";
	return e.originInherited ? `${base} (from policy check)` : base;
}

export function resourceText(e: Pick<ChangeEvent, "resourceTitle" | "resourceSlug" | "resourceKey" | "protectedResource">): string {
	const name = e.resourceTitle ?? e.resourceSlug ?? e.resourceKey ?? "—";
	return e.protectedResource ? `🛡 ${name}` : name;
}

export const EVENT_COLUMNS: TableColumn[] = [
	{ key: "when", label: "When", format: "relative_time" },
	{ key: "severity", label: "Severity", format: "badge" },
	{ key: "origin", label: "Origin", format: "badge" },
	{ key: "resource", label: "Resource" },
	{ key: "summary", label: "What changed" },
];

export function eventRow(e: ChangeEvent, extra?: Record<string, unknown>): Record<string, unknown> {
	return {
		when: e.createdAt,
		severity: SEVERITY_LABEL[e.severity],
		origin: origin(e),
		resource: resourceText(e),
		summary: e.summary,
		...(extra ?? {}),
	};
}

export const INCIDENT_COLUMNS: TableColumn[] = [
	{ key: "id", label: "Incident", format: "code" },
	{ key: "severity", label: "Severity", format: "badge" },
	{ key: "status", label: "Status", format: "badge" },
	{ key: "title", label: "Summary" },
	{ key: "origins", label: "Origins" },
	{ key: "events", label: "Events", format: "number" },
	{ key: "updated", label: "Last activity", format: "relative_time" },
];

export function incidentRow(i: Incident): Record<string, unknown> {
	return {
		id: i.id,
		severity: SEVERITY_LABEL[i.severity],
		status: i.status[0]?.toUpperCase() + i.status.slice(1),
		title: i.title,
		origins: i.originSources.map((s) => ORIGIN_LABELS[s] ?? s).join(", "),
		events: i.eventCount,
		updated: i.lastEventAt,
	};
}

export function startOfDayIso(now: number): string {
	const d = new Date(now);
	d.setUTCHours(0, 0, 0, 0);
	return d.toISOString();
}

export function errorBanner(message: string): Block {
	return { type: "banner", variant: "error", description: message };
}

export function budgetNote(): Block {
	return { type: "context", text: "Some figures were skipped to stay within the plugin sandbox request budget. Reload to see the rest." };
}
