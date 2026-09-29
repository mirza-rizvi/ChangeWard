import type { Store } from "../core/store";
import type { ChangeEvent, Incident } from "../core/types";
import { EVENT_COLUMNS, INCIDENT_COLUMNS, budgetNote, eventRow, incidentRow, page, startOfDayIso, type Block, type BlockResponse } from "./ui";

const OPEN = { in: ["open", "investigating"] };

async function safe<T>(fn: () => Promise<T>, fallback: T, flags: { skipped: boolean }): Promise<T> {
	try {
		return await fn();
	} catch {
		flags.skipped = true;
		return fallback;
	}
}

/** Budget: 5 counts + 3 queries = 8 bridge calls. */
export async function overviewPage(store: Store, now = Date.now()): Promise<BlockResponse> {
	const today = { gte: startOfDayIso(now) };
	const flags = { skipped: false };
	const changes = await safe(() => store.countEvents({ createdAt: today }), 0, flags);
	const mcp = await safe(() => store.countEvents({ originSource: "mcp", createdAt: today }), 0, flags);
	const protectedChanges = await safe(() => store.countEvents({ protectedResource: true, createdAt: today }), 0, flags);
	const blocked = await safe(() => store.countEvents({ action: "policy.block", createdAt: today }), 0, flags);
	const open = await safe(() => store.countIncidents({ status: OPEN }), 0, flags);
	const incidents = await safe(() => store.queryIncidents({ status: OPEN }, 5), { items: [], hasMore: false }, flags);
	const important = await safe(() => store.queryEvents({ severity: { in: ["high", "critical"] } }, 5), { items: [], hasMore: false }, flags);
	const mcpRecent = await safe(() => store.queryEvents({ originSource: "mcp" }, 5), { items: [], hasMore: false }, flags);

	const blocks: Block[] = [
		{
			type: "stats",
			items: [
				{ label: "Changes today", value: changes },
				{ label: "MCP changes today", value: mcp },
				{ label: "Protected-resource changes today", value: protectedChanges },
				{ label: "Blocked publications today", value: blocked },
				{ label: "Open incidents", value: open, ...(open > 0 ? { trend: "up" as const } : {}) },
			],
		},
		{
			type: "context",
			text: "EmDash reports the origin (MCP, API, visual editor, plugin, scheduler) for publish, schedule and unpublish actions. Saves carry the signed-in user but not the origin, so they show as “User (origin not reported)”.",
		},
		{ type: "header", text: "Open incidents" },
		{
			type: "table",
			block_id: "overview:incidents",
			columns: INCIDENT_COLUMNS,
			rows: incidents.items.map((x) => incidentRow(x.data as Incident)),
			page_action_id: "overview:noop",
			empty_text: "No open incidents.",
		},
		{ type: "header", text: "Recent important changes" },
		{
			type: "table",
			block_id: "overview:important",
			columns: EVENT_COLUMNS,
			rows: important.items.map((x) => eventRow(x.data as ChangeEvent)),
			page_action_id: "overview:noop",
			empty_text: "No high-severity changes recorded.",
		},
		{ type: "header", text: "Recent MCP activity" },
		{ type: "context", text: "Changes EmDash reported as arriving through its MCP server. MCP clients can be AI agents, developer tools, or other automation; ChangeWard does not guess which." },
		{
			type: "table",
			block_id: "overview:mcp",
			columns: EVENT_COLUMNS,
			rows: mcpRecent.items.map((x) => eventRow(x.data as ChangeEvent)),
			page_action_id: "overview:noop",
			empty_text: "No MCP activity recorded.",
		},
		{
			type: "actions",
			elements: [
				{ type: "link", label: "All activity", target: { kind: "plugin-page", path: "/activity" } },
				{ type: "link", label: "All incidents", target: { kind: "plugin-page", path: "/incidents" } },
			],
		},
	];
	if (flags.skipped) blocks.push(budgetNote());
	return page("/overview", "ChangeWard", blocks);
}

/** Dashboard widget: status. Budget: 4 counts. */
export async function statusWidget(store: Store, now = Date.now()): Promise<BlockResponse> {
	const today = { gte: startOfDayIso(now) };
	const flags = { skipped: false };
	const open = await safe(() => store.countIncidents({ status: OPEN }), 0, flags);
	const protectedCount = await safe(() => store.countResources({ isProtected: true }), 0, flags);
	const changes = await safe(() => store.countEvents({ createdAt: today }), 0, flags);
	const mcp = await safe(() => store.countEvents({ originSource: "mcp", createdAt: today }), 0, flags);
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Open incidents", value: open },
					{ label: "Protected resources", value: protectedCount },
					{ label: "Changes today", value: changes },
					{ label: "MCP changes today", value: mcp },
				],
			},
			{ type: "actions", elements: [{ type: "link", label: "Open ChangeWard", target: { kind: "plugin-page", path: "/overview" } }] },
		],
	};
}

/** Dashboard widget: newest unresolved incidents. Budget: 1 query. */
export async function incidentsWidget(store: Store): Promise<BlockResponse> {
	const flags = { skipped: false };
	const res = await safe(() => store.queryIncidents({ status: OPEN }, 5), { items: [], hasMore: false }, flags);
	return {
		blocks: [
			{
				type: "table",
				block_id: "widget:incidents",
				columns: INCIDENT_COLUMNS.filter((c) => c.key !== "origins" && c.key !== "events"),
				rows: res.items.map((x) => incidentRow(x.data as Incident)),
				page_action_id: "incidents:page",
				empty_text: "No open incidents.",
			},
			{ type: "actions", elements: [{ type: "link", label: "All incidents", target: { kind: "plugin-page", path: "/incidents" } }] },
		],
	};
}
