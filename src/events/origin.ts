import type { Attribution, OriginSource } from "../core/types";
import { isRecord } from "../core/validate";

const KNOWN: ReadonlySet<string> = new Set(["api", "mcp", "visual-editor", "plugin", "scheduler", "system"]);
const RAW_RE = /^[a-z][a-z0-9._-]{0,31}$/;
const ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

function safeId(value: unknown): string | undefined {
	return typeof value === "string" && ID_RE.test(value) ? value : undefined;
}

function actorFields(actor: unknown): Pick<Attribution, "actorId" | "actorRole" | "actorSource"> {
	if (!isRecord(actor)) return {};
	const out: Pick<Attribution, "actorId" | "actorRole" | "actorSource"> = {};
	const id = safeId(actor.id);
	if (id) out.actorId = id;
	if (typeof actor.role === "number" && Number.isInteger(actor.role)) out.actorRole = actor.role;
	if (typeof actor.source === "string" && RAW_RE.test(actor.source)) out.actorSource = actor.source;
	return out;
}

function sourceOf(raw: unknown): { source: OriginSource; rawSource?: string } {
	if (typeof raw !== "string") return { source: "unattributed" };
	if (KNOWN.has(raw)) return { source: raw as OriginSource };
	// Future EmDash origins are kept verbatim but classified as unknown.
	return RAW_RE.test(raw) ? { source: "unknown", rawSource: raw } : { source: "unknown" };
}

/** From a publication-policy event's `origin` (authoritative) and optional `actor`. */
export function attributionFromPolicy(origin: unknown, actor: unknown): Attribution {
	const base = isRecord(origin) ? sourceOf(origin.source) : { source: "unattributed" as const };
	const out: Attribution = { ...base, ...actorFields(actor) };
	if (isRecord(origin) && origin.source === "plugin") {
		const pluginId = safeId(origin.pluginId);
		if (pluginId) out.pluginId = pluginId;
	}
	return out;
}

/**
 * From a save event's `actor`. EmDash 1.0 includes the acting user on authenticated saves but, as
 * its docs state, not the request origin. `actor.source` is honoured if a future version sends it;
 * otherwise the save is unattributed with the user kept. Never guessed.
 */
export function attributionFromActor(actor: unknown): Attribution {
	const fields = actorFields(actor);
	if (!fields.actorSource) return { source: "unattributed", ...fields };
	return { ...sourceOf(fields.actorSource), ...fields };
}

export const ORIGIN_LABELS: Record<OriginSource, string> = {
	api: "API",
	mcp: "MCP",
	"visual-editor": "Visual editor",
	plugin: "Plugin",
	scheduler: "Scheduler",
	system: "System",
	unattributed: "Origin not reported",
	unknown: "Unknown",
};

export function originLabel(a: Pick<Attribution, "source" | "pluginId" | "rawSource">): string {
	if (a.source === "plugin" && a.pluginId) return `Plugin ${a.pluginId}`;
	if (a.source === "unknown" && a.rawSource) return `Unknown (${a.rawSource})`;
	return ORIGIN_LABELS[a.source];
}

/** Human-facing phrasing: "via MCP", "through the visual editor". Never claims AI involvement. */
export function viaPhrase(a: Pick<Attribution, "source" | "pluginId" | "rawSource" | "actorId">): string {
	switch (a.source) {
		case "visual-editor":
			return "through the visual editor";
		case "plugin":
			return a.pluginId ? `by plugin ${a.pluginId}` : "by a plugin";
		case "scheduler":
			return "by the scheduler";
		case "system":
			return "by the system";
		case "unattributed":
			// EmDash reports the signed-in user on saves, but not whether the save came through
			// the REST API, MCP or the visual editor.
			return a.actorId ? "by a signed-in user (origin not reported)" : "(origin not reported)";
		case "unknown":
			return a.rawSource ? `via ${a.rawSource}` : "via an unknown origin";
		default:
			return `via ${ORIGIN_LABELS[a.source]}`;
	}
}

export function isAutomation(source: OriginSource): boolean {
	return source === "mcp" || source === "api" || source === "plugin";
}

/** Key used to group activity by the same actor through the same origin. */
export function originKey(a: Attribution): string {
	return `${a.source}:${a.actorId ?? a.pluginId ?? "-"}`;
}
