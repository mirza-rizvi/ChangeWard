import { INCIDENT_STATUSES, type ChangeEvent, type ResourceState } from "../core/types";
import { Store } from "../core/store";
import { isRecord, oneOf, token } from "../core/validate";
import { activityPage, eventDetail, filterWhere } from "./activity";
import { classifyDomain, policiesPage, savePolicies, saveSettings, settingsPage } from "./config-pages";
import { changeIncidentStatus, incidentDetail, incidentsPage } from "./incidents";
import { parseInteraction, resolveTarget, splitValue, type Interaction } from "./interaction";
import { incidentsWidget, overviewPage, statusWidget } from "./overview";
import { captureBaseline, compareResource, parseResourceKey, protectResource, protectedPage, unprotectResource } from "./protected";
import { EVENT_COLUMNS, eventRow, page, type BlockResponse } from "./ui";

const INCIDENT_ID_RE = /^CW-[0-9a-z-]{1,40}$/;
const EVENT_ID_RE = /^[0-9a-z]{9}-[0-9a-z]{6,24}$/;

function cursorOf(value: unknown): string | undefined {
	return isRecord(value) && typeof value.cursor === "string" && value.cursor.length <= 512 ? value.cursor : undefined;
}

function filterFromBlock(blockId: string | undefined, prefix: string): string | undefined {
	return blockId?.startsWith(prefix) ? blockId.slice(prefix.length) : undefined;
}

export interface AdminRequest {
	input: unknown;
	userId?: string;
	/** Host-attested surface (`admin-page` or `dashboard-widget`). */
	surface?: string;
}

/** Single entry point for every ChangeWard admin page and widget. All input is validated here. */
export async function handleAdmin(store: Store, req: AdminRequest): Promise<BlockResponse> {
	const interaction = parseInteraction(req.input);
	if (!interaction) return { blocks: [{ type: "banner", variant: "error", description: "ChangeWard could not read this request." }] };
	try {
		if (interaction.type === "page_load" && req.surface === "dashboard-widget") {
			const name = interaction.page.replace(/^widget:/, "").replace(/^\/+/, "");
			return name === "incidents" ? await incidentsWidget(store) : await statusWidget(store);
		}
		return await dispatch(store, interaction, req.userId);
	} catch (error) {
		store.host.log.error("ChangeWard admin request failed", { action: "action_id" in interaction ? interaction.action_id : interaction.page, error: error instanceof Error ? error.name : "unknown" });
		return { blocks: [{ type: "banner", variant: "error", title: "Something went wrong", description: "ChangeWard could not complete this request. Reload the page and try again." }] };
	}
}

async function dispatch(store: Store, i: Interaction, userId: string | undefined): Promise<BlockResponse> {
	if (i.type === "page_load") {
		const target = resolveTarget(i.page);
		if (target.kind === "widget") return target.name === "status" ? statusWidget(store) : incidentsWidget(store);
		switch (target.name) {
			case "activity":
				return activityPage(store);
			case "incidents":
				return incidentsPage(store);
			case "protected":
				return protectedPage(store);
			case "policies":
				return policiesPage(store);
			case "settings":
				return settingsPage(store);
			default:
				return overviewPage(store);
		}
	}

	if (i.type === "form_submit") {
		switch (i.action_id) {
			case "activity:filter": {
				const f = typeof i.values.filter === "string" && filterWhere(i.values.filter) ? i.values.filter : "all";
				return activityPage(store, f);
			}
			case "incidents:filter":
				return incidentsPage(store, typeof i.values.status === "string" ? i.values.status : "active");
			case "protected:add":
				return protectResource(store, { collection: i.values.collection, id: i.values.id, label: i.values.label, notes: i.values.notes, baseline: i.values.baseline }, userId);
			case "policies:save":
				return savePolicies(store, i.values, i.block_id, userId);
			case "settings:save":
				return saveSettings(store, i.values, i.block_id, userId);
			default:
				return overviewPage(store);
		}
	}

	// block_action
	switch (i.action_id) {
		case "activity:page": {
			const f = filterFromBlock(i.block_id, "activity:f:") ?? "all";
			return activityPage(store, filterWhere(f) ? f : "all", cursorOf(i.value));
		}
		case "activity:first":
			return activityPage(store, typeof i.value === "string" && filterWhere(i.value) ? i.value : "all");
		case "activity:row":
		case "protected:row": {
			const parts = splitValue(i.value, 2);
			if (!parts) return activityPage(store, "all", undefined, { type: "error", message: "Invalid action." });
			const [op = "", arg = ""] = parts;
			if (op === "detail" && EVENT_ID_RE.test(arg)) {
				const e = await store.event(arg);
				if (!e) return activityPage(store, "all", undefined, { type: "error", message: "Event not found (it may have expired)." });
				return page("/activity", "Change detail", [...eventDetail(e as ChangeEvent), { type: "actions", elements: [{ type: "button", label: "Back to activity", action_id: "activity:first", value: "all" }] }]);
			}
			if (op === "incident" && INCIDENT_ID_RE.test(arg)) return incidentDetail(store, arg);
			if (!parseResourceKey(arg)) return activityPage(store, "all", undefined, { type: "error", message: "Invalid resource." });
			if (op === "history") return activityPage(store, `resource:${arg}`);
			if (op === "protect") {
				const key = parseResourceKey(arg);
				return protectResource(store, { collection: key?.collection, id: key?.id, baseline: true }, userId);
			}
			if (op === "baseline") return captureBaseline(store, arg, userId);
			if (op === "compare") return compareResource(store, arg);
			if (op === "unprotect") return unprotectResource(store, arg, userId);
			return activityPage(store, "all", undefined, { type: "error", message: "Invalid action." });
		}
		case "protected:page":
			return protectedPage(store, cursorOf(i.value));
		case "incidents:page": {
			const f = filterFromBlock(i.block_id, "incidents:f:") ?? "active";
			return incidentsPage(store, f, cursorOf(i.value));
		}
		case "incidents:back":
			return incidentsPage(store);
		case "incidents:row": {
			const view = splitValue(i.value, 2);
			if (view && view[0] === "view" && INCIDENT_ID_RE.test(view[1] ?? "")) return incidentDetail(store, view[1] ?? "");
			const change = splitValue(i.value, 3);
			const to = oneOf(change?.[2], INCIDENT_STATUSES);
			if (change && change[0] === "status" && INCIDENT_ID_RE.test(change[1] ?? "") && to) return changeIncidentStatus(store, change[1] ?? "", to, userId);
			return incidentsPage(store, "active", undefined, { type: "error", message: "Invalid action." });
		}
		case "incidents:status": {
			const parts = splitValue(i.value, 2);
			const to = oneOf(parts?.[1], INCIDENT_STATUSES);
			if (!parts || !INCIDENT_ID_RE.test(parts[0] ?? "") || !to) return incidentsPage(store, "active", undefined, { type: "error", message: "Invalid action." });
			return changeIncidentStatus(store, parts[0] ?? "", to, userId);
		}
		case "policies:domain": {
			const parts = splitValue(i.value, 2);
			if (!parts) return policiesPage(store, { type: "error", message: "Invalid action." });
			return classifyDomain(store, parts[0] ?? "", parts[1] ?? "", userId);
		}
		default: {
			// Sorting or paging on read-only tables re-renders the originating page.
			const target = resolveTarget(i.page, i.action_id);
			if (target.kind === "widget") return target.name === "status" ? statusWidget(store) : incidentsWidget(store);
			return dispatch(store, { type: "page_load", page: `/${target.name}` }, userId);
		}
	}
}

// ── saved-entry panel ─────────────────────────────────────

export interface PanelRequest {
	input: unknown;
	entry?: { collection?: unknown; id?: unknown };
	userId?: string;
}

/** Entry-editor panel: protection status and the latest changes for this entry. Budget ≤ 6. */
export async function handlePanel(store: Store, req: PanelRequest): Promise<BlockResponse> {
	const collection = token(req.entry?.collection);
	const id = token(req.entry?.id);
	if (!collection || !id) return { blocks: [{ type: "context", text: "Save the entry to see its ChangeWard history." }] };
	const key = `${collection}:${id}`;
	const input = isRecord(req.input) ? req.input : {};
	let toast: BlockResponse["toast"] | undefined;
	if (input.type === "block_action" && (input.action_id === "panel:protect" || input.action_id === "panel:unprotect")) {
		if (input.action_id === "panel:protect") await protectResource(store, { collection, id, baseline: true }, req.userId);
		else await unprotectResource(store, key, req.userId);
		toast = { type: "success", message: input.action_id === "panel:protect" ? "Protected with a known good state." : "No longer protected." };
		// The helpers above render the Protected page; the panel renders its own view below.
	}
	const resource = (await store.resource(key)) as ResourceState | null;
	const recent = await store.queryEvents({ resourceKey: key }, 5);
	return {
		blocks: [
			{
				type: "fields",
				fields: [
					{ label: "Protected", value: resource?.isProtected ? "Yes" : "No" },
					{ label: "Known good state", value: resource?.baseline ? (resource.lastHash === resource.baseline.hash ? "Matches" : "Changed since capture") : "None" },
				],
			},
			{
				type: "table",
				block_id: "panel:recent",
				columns: EVENT_COLUMNS.filter((c) => c.key !== "resource"),
				rows: recent.items.map((x) => eventRow(x.data as ChangeEvent)),
				page_action_id: "panel:noop",
				empty_text: "No changes recorded yet.",
			},
			{
				type: "actions",
				elements: [
					resource?.isProtected
						? { type: "button", label: "Stop protecting", action_id: "panel:unprotect", confirm: { title: "Stop protecting?", text: "Stricter monitoring and protected-content policies will no longer apply to this entry.", confirm: "Stop protecting", deny: "Cancel" } }
						: { type: "button", label: "Protect this entry", action_id: "panel:protect", style: "primary" },
					{ type: "link", label: "Full history", target: { kind: "plugin-page", path: "/activity" } },
				],
			},
		],
		...(toast ? { toast } : {}),
	};
}
