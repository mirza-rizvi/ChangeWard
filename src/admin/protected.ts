import { LIMITS } from "../core/limits";
import type { Store } from "../core/store";
import type { ResourceState } from "../core/types";
import { cleanText, isRecord, token } from "../core/validate";
import { resourceKeyOf } from "../events/pipeline";
import { recordAdminAction } from "../events/admin-audit";
import { nextResourceState, titleOf } from "../events/recorder";
import { compareToBaseline, describeDrift, makeBaseline } from "../integrity/baseline";
import { fingerprint, shortHash } from "../integrity/hash";
import { hostOf } from "../intelligence/domains";
import { externalHosts, extract } from "../intelligence/urls";
import { page, utc, type Block, type BlockResponse } from "./ui";

export function parseResourceKey(value: string): { collection: string; id: string } | undefined {
	const i = value.indexOf(":");
	if (i <= 0) return undefined;
	const collection = token(value.slice(0, i));
	const id = token(value.slice(i + 1));
	return collection && id ? { collection, id } : undefined;
}

function baselineText(r: ResourceState): string {
	if (!r.baseline) return "None";
	const state = r.lastHash === undefined ? "" : r.lastHash === r.baseline.hash ? " · matches" : " · changed since";
	return `${r.baseline.capturedAt.slice(0, 16).replace("T", " ")} UTC${state}`;
}

/** Budget: 1 query. */
export async function protectedPage(store: Store, cursor?: string, toast?: BlockResponse["toast"], extra: Block[] = []): Promise<BlockResponse> {
	const res = await store.queryResources({ isProtected: true }, LIMITS.pageSize, cursor);
	const rows = res.items.map((x) => {
		const r = x.data as ResourceState;
		return {
			label: r.label ?? r.title ?? r.slug ?? r.key,
			key: r.key,
			status: r.deleted ? "Trashed" : (r.lastStatus ?? "—"),
			baseline: baselineText(r),
			since: r.protectedAt ?? "",
			actions: {
				type: "menu",
				action_id: "protected:row",
				label: "Actions",
				items: [
					{ label: "Compare with baseline", value: `compare|${r.key}` },
					{ label: r.baseline ? "Re-capture known good state" : "Capture known good state", value: `baseline|${r.key}` },
					{ label: "Activity for this resource", value: `history|${r.key}` },
					{ label: "Stop protecting", value: `unprotect|${r.key}` },
				],
			},
		};
	});
	const blocks: Block[] = [
		...extra,
		{
			type: "section",
			text: "Protected resources get stricter monitoring: every change is recorded with raised severity, and the protected-content publishing policies apply. Protection never blocks saving.",
		},
		{
			type: "table",
			block_id: "protected:list",
			columns: [
				{ key: "label", label: "Resource" },
				{ key: "key", label: "Collection:ID", format: "code" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "baseline", label: "Known good state" },
				{ key: "since", label: "Protected", format: "relative_time" },
				{ key: "actions", label: "", format: "element" },
			],
			rows,
			page_action_id: "protected:page",
			...(res.hasMore && res.cursor ? { next_cursor: res.cursor } : {}),
			empty_text: "No protected resources yet. Add one below, or use “Protect this resource” in Activity.",
		},
		{ type: "header", text: "Protect a resource" },
		{
			type: "form",
			block_id: "protected:add",
			fields: [
				{ type: "text_input", action_id: "collection", label: "Collection slug", placeholder: "pages" },
				{ type: "text_input", action_id: "id", label: "Entry ID", placeholder: "01J…" },
				{ type: "text_input", action_id: "label", label: "Label (optional)", placeholder: "Pricing" },
				{ type: "text_input", action_id: "notes", label: "Notes (optional)", multiline: true },
				{ type: "toggle", action_id: "baseline", label: "Capture the current state as known good", initial_value: true },
			],
			submit: { label: "Protect", action_id: "protected:add" },
		},
	];
	return page("/protected", "Protected content", blocks, toast);
}

interface Loaded {
	key: string;
	collection: string;
	id: string;
	item: Record<string, unknown>;
}

async function loadEntry(store: Store, collection: string, id: string): Promise<Loaded | string> {
	const content = store.host.content;
	if (!content) return "Content access is unavailable.";
	const item = await store.budget.call(() => content.get(collection, id));
	if (!isRecord(item)) return `No entry ${id} in collection ${collection}.`;
	return { key: resourceKeyOf(collection, id), collection, id, item };
}

async function baselineFor(store: Store, loaded: Loaded, userId: string | undefined, now: number) {
	const data = isRecord(loaded.item.data) ? loaded.item.data : {};
	const fp = await fingerprint(loaded.item.slug, data);
	const extraction = extract(data, hostOf(store.host.site.url));
	const baseline = makeBaseline({
		hash: fp.hash,
		hosts: externalHosts(extraction),
		status: typeof loaded.item.status === "string" ? loaded.item.status : "unknown",
		capturedAt: new Date(now).toISOString(),
		...(userId ? { capturedBy: userId } : {}),
		partial: fp.partial || extraction.partial,
	});
	return { baseline, fp, extraction };
}

/**
 * Protect (or update) a resource. Budget: content 1, resource 1, put 1, page 1.
 * The entry must exist; ChangeWard never protects IDs it cannot read.
 */
export async function protectResource(
	store: Store,
	input: { collection: unknown; id: unknown; label?: unknown; notes?: unknown; baseline?: unknown },
	userId: string | undefined,
	now = Date.now(),
): Promise<BlockResponse> {
	const collection = token(input.collection);
	const id = token(input.id);
	if (!collection || !id) return protectedPage(store, undefined, { type: "error", message: "Enter a valid collection slug and entry ID." });
	const loaded = await loadEntry(store, collection, id);
	if (typeof loaded === "string") return protectedPage(store, undefined, { type: "error", message: loaded });
	const prev = await store.resource(loaded.key);
	const title = titleOf(loaded.item);
	const slug = typeof loaded.item.slug === "string" ? loaded.item.slug : undefined;
	const status = typeof loaded.item.status === "string" ? loaded.item.status : undefined;
	const capture = input.baseline !== false;
	const b = capture ? await baselineFor(store, loaded, userId, now) : undefined;
	const next = nextResourceState(prev, { action: "update", collection, resourceId: id }, loaded.key, now, {
		title,
		slug,
		status,
		...(b ? { fp: b.fp.hash, extraction: b.extraction } : {}),
	});
	next.isProtected = true;
	next.protectedAt = prev?.isProtected && prev.protectedAt ? prev.protectedAt : new Date(now).toISOString();
	const label = cleanText(input.label, LIMITS.labelChars);
	const notes = cleanText(input.notes, LIMITS.notesChars);
	if (label) next.label = label;
	if (notes) next.notes = notes;
	if (b) next.baseline = b.baseline;
	await store.putResource(next);
	const name = label || title || loaded.key;
	await recordAdminAction(store, {
		action: prev?.isProtected ? (b ? "protection.baseline" : "protection.updated") : "protection.added",
		summary: prev?.isProtected ? `Known good state ${b ? "captured" : "unchanged"} for "${name}"` : `"${name}" marked as protected${b ? " with a known good state" : ""}`,
		collection,
		resourceId: id,
		resourceTitle: name,
		protectedResource: true,
		...(userId ? { userId } : {}),
	}, now);
	return protectedPage(store, undefined, { type: "success", message: `Protecting ${label || title || loaded.key}${b ? " with a known good state" : ""}.` });
}

/** Budget: content 1, resource 1, put 1, page 1. */
export async function captureBaseline(store: Store, key: string, userId: string | undefined, now = Date.now()): Promise<BlockResponse> {
	const parsed = parseResourceKey(key);
	if (!parsed) return protectedPage(store, undefined, { type: "error", message: "Invalid resource." });
	return protectResource(store, { collection: parsed.collection, id: parsed.id, baseline: true }, userId, now);
}

/** Budget: resource 1, put 1, page 1. Keeps the activity history; removes the baseline. */
export async function unprotectResource(store: Store, key: string, userId?: string, now = Date.now()): Promise<BlockResponse> {
	const r = parseResourceKey(key) ? await store.resource(key) : null;
	if (!r) return protectedPage(store, undefined, { type: "error", message: "Resource not found." });
	const { baseline: _b, protectedAt: _p, label: _l, notes: _n, ...rest } = r;
	await store.putResource({ ...rest, isProtected: false, updatedAt: new Date(now).toISOString() });
	await recordAdminAction(store, {
		action: "protection.removed",
		summary: `"${r.label ?? r.title ?? r.key}" is no longer protected`,
		severity: "low",
		collection: r.collection,
		resourceId: r.resourceId,
		resourceTitle: r.label ?? r.title ?? r.key,
		...(userId ? { userId } : {}),
	}, now);
	return protectedPage(store, undefined, { type: "success", message: `No longer protecting ${r.label ?? r.title ?? r.key}.` });
}

/** Budget: resource 1, content 1, page 1. Read-only comparison with the known good state. */
export async function compareResource(store: Store, key: string): Promise<BlockResponse> {
	const parsed = parseResourceKey(key);
	const r = parsed ? await store.resource(key) : null;
	if (!parsed || !r) return protectedPage(store, undefined, { type: "error", message: "Resource not found." });
	if (!r.baseline) return protectedPage(store, undefined, { type: "info", message: "Capture a known good state first." });
	const loaded = await loadEntry(store, parsed.collection, parsed.id);
	if (typeof loaded === "string") return protectedPage(store, undefined, { type: "error", message: loaded });
	const data = isRecord(loaded.item.data) ? loaded.item.data : {};
	const fp = await fingerprint(loaded.item.slug, data);
	const hosts = externalHosts(extract(data, hostOf(store.host.site.url)));
	const drift = compareToBaseline(r.baseline, { hash: fp.hash, hosts, ...(typeof loaded.item.status === "string" ? { status: loaded.item.status } : {}) });
	const name = r.label ?? r.title ?? r.key;
	const extra: Block[] = [
		{
			type: "banner",
			variant: drift.changed ? "alert" : "default",
			title: `${name}: ${drift.changed ? "changed since the known good state" : "matches the known good state"}`,
			description: describeDrift(drift).join(" "),
		},
		{
			type: "fields",
			fields: [
				{ label: "Baseline captured", value: utc(r.baseline.capturedAt) },
				{ label: "Baseline fingerprint", value: shortHash(r.baseline.hash) },
				{ label: "Current fingerprint", value: shortHash(fp.hash) },
				{ label: "Baseline status", value: r.baseline.status },
			],
		},
	];
	if (r.baseline.partial || fp.partial) extra.push({ type: "context", text: "The fingerprint covers content up to ChangeWard's processing limit." });
	extra.push({ type: "actions", elements: [{ type: "link", label: "Open entry and its revisions", target: { kind: "content", collection: parsed.collection, id: parsed.id } }] });
	return protectedPage(store, undefined, undefined, extra);
}
