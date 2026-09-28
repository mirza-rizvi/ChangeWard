import { isRecord } from "../core/validate";

export type Interaction =
	| { type: "page_load"; page: string }
	| { type: "block_action"; action_id: string; block_id?: string; value?: unknown; page?: string }
	| { type: "form_submit"; action_id: string; block_id?: string; values: Record<string, unknown>; page?: string };

const ACTION_RE = /^[a-z][a-z0-9_:-]{0,63}$/;

function short(v: unknown, max: number): string | undefined {
	return typeof v === "string" && v.length <= max ? v : undefined;
}

/** Validate the admin interaction envelope. Values inside stay `unknown` for per-action validation. */
export function parseInteraction(input: unknown): Interaction | undefined {
	if (!isRecord(input)) return undefined;
	const page = short(input.page, 128);
	const block_id = short(input.block_id, 256);
	switch (input.type) {
		case "page_load":
			return page !== undefined ? { type: "page_load", page } : undefined;
		case "block_action": {
			const action_id = short(input.action_id, 64);
			if (!action_id || !ACTION_RE.test(action_id)) return undefined;
			return { type: "block_action", action_id, ...(block_id ? { block_id } : {}), ...("value" in input ? { value: input.value } : {}), ...(page ? { page } : {}) };
		}
		case "form_submit": {
			const action_id = short(input.action_id, 64);
			if (!action_id || !ACTION_RE.test(action_id) || !isRecord(input.values)) return undefined;
			return { type: "form_submit", action_id, values: input.values, ...(block_id ? { block_id } : {}), ...(page ? { page } : {}) };
		}
		default:
			return undefined;
	}
}

export const PAGES = ["overview", "activity", "incidents", "protected", "policies", "settings"] as const;
export type PageName = (typeof PAGES)[number];
export const WIDGETS = ["status", "incidents"] as const;
export type WidgetName = (typeof WIDGETS)[number];

export type Target = { kind: "page"; name: PageName } | { kind: "widget"; name: WidgetName };

/** Map the admin's page identifier (`/activity`, `widget:status`, `status`) to a ChangeWard view. */
export function resolveTarget(page: string | undefined, actionId?: string): Target {
	const raw = (page ?? "").trim();
	const widget = raw.startsWith("widget:") ? raw.slice(7) : raw;
	if ((WIDGETS as readonly string[]).includes(widget) && !raw.startsWith("/")) return { kind: "widget", name: widget as WidgetName };
	const name = raw.replace(/^\/+/, "").split(/[/?#]/)[0] ?? "";
	if ((PAGES as readonly string[]).includes(name)) return { kind: "page", name: name as PageName };
	const prefix = actionId?.split(":")[0];
	if (prefix && (PAGES as readonly string[]).includes(prefix)) return { kind: "page", name: prefix as PageName };
	return { kind: "page", name: "overview" };
}

/** Split `op|arg1|arg2` menu values; each part is length-checked by the caller's validators. */
export function splitValue(value: unknown, parts: number): string[] | undefined {
	if (typeof value !== "string" || value.length > 400) return undefined;
	const out = value.split("|");
	return out.length === parts ? out : undefined;
}
