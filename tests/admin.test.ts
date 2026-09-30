import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAdmin, handlePanel } from "../src/admin/route";
import { parseInteraction, resolveTarget } from "../src/admin/interaction";
import { canTransition } from "../src/admin/incidents";
import { defaultConfig, normalizeConfig } from "../src/core/config";
import { Store } from "../src/core/store";
import { startOfDayIso, type BlockResponse } from "../src/admin/ui";
import type { ChangeEvent, Incident, ResourceState } from "../src/core/types";
import { recordContentChange } from "../src/events/recorder";
import { fakeHost, type FakeHost } from "./support/fake-host";

const PAGES = ["/overview", "/activity", "/incidents", "/protected", "/policies", "/settings"];
const POLICY = { pluginPagePaths: PAGES };
let host: FakeHost;

async function call(input: unknown, surface?: string): Promise<{ res: BlockResponse; used: number }> {
	const s = new Store(host);
	const res = await handleAdmin(s, { input, userId: "admin1", ...(surface ? { surface } : {}) });
	return { res, used: s.budget.used };
}
function text(res: BlockResponse): string {
	return JSON.stringify(res);
}
function valid(res: BlockResponse) {
	const v = validateBlockResponse(res, POLICY);
	expect(v.errors).toEqual([]);
	expect(v.valid).toBe(true);
}

beforeEach(async () => {
	host = fakeHost();
	await host.settings.set("config", defaultConfig());
	host.content.items.set("pages:p1", { id: "p1", slug: "pricing", status: "published", data: { title: "Pricing", cta: "https://pay.example/buy" } });
	// Seed at the start of the current UTC day so "today" counts are stable whenever the test runs.
	const startOfToday = Date.parse(startOfDayIso(Date.now()));
	for (let i = 0; i < 30; i += 1) {
		await recordContentChange(new Store(host), { action: "create", collection: "pages", resourceId: `d${i}`, content: { id: `d${i}`, slug: `d${i}`, status: "draft", data: { title: `Doc ${i}` } }, attribution: { source: i % 2 ? "mcp" : "api", actorId: `u${i}` } }, startOfToday + i * 5000);
	}
});

describe("interaction validation", () => {
	it("accepts the three documented shapes", () => {
		expect(parseInteraction({ type: "page_load", page: "/activity" })).toEqual({ type: "page_load", page: "/activity" });
		expect(parseInteraction({ type: "block_action", action_id: "activity:row", value: "x" })?.type).toBe("block_action");
		expect(parseInteraction({ type: "form_submit", action_id: "settings:save", values: {} })?.type).toBe("form_submit");
	});
	it("rejects malformed or oversized input", () => {
		for (const bad of [null, "x", { type: "page_load" }, { type: "block_action", action_id: "Bad Id" }, { type: "form_submit", action_id: "a", values: [] }, { type: "block_action", action_id: "x".repeat(65) }, { type: "evil" }]) {
			expect(parseInteraction(bad)).toBeUndefined();
		}
	});
	it("maps pages and widgets", () => {
		expect(resolveTarget("/incidents")).toEqual({ kind: "page", name: "incidents" });
		expect(resolveTarget("widget:status")).toEqual({ kind: "widget", name: "status" });
		expect(resolveTarget("/nope")).toEqual({ kind: "page", name: "overview" });
	});
	it("answers garbage with an error banner, not an exception", async () => {
		const { res } = await call({ type: "block_action", action_id: "activity:row", value: "protect|../../etc" });
		expect(text(res)).toContain("Invalid");
		expect((await call(42)).res.blocks[0]).toMatchObject({ type: "banner", variant: "error" });
	});
});

describe("pages render valid Block Kit within the bridge budget", () => {
	for (const p of PAGES) {
		it(p, async () => {
			const { res, used } = await call({ type: "page_load", page: p });
			valid(res);
			expect(used).toBeLessThanOrEqual(9);
			expect(text(res)).not.toMatch(/malware|hacker|compromised|AI attack/i);
		});
	}
	it("widgets", async () => {
		for (const w of ["status", "incidents"]) {
			const { res, used } = await call({ type: "page_load", page: w }, "dashboard-widget");
			valid(res);
			expect(used).toBeLessThanOrEqual(5);
		}
	});
	it("overview shows the operational numbers", async () => {
		const { res } = await call({ type: "page_load", page: "/overview" });
		const stats = res.blocks.find((b) => b.type === "stats") as { items: Array<{ label: string; value: number }> };
		expect(stats.items.map((i) => i.label)).toEqual(["Changes today", "MCP changes today", "Protected-resource changes today", "Blocked publications today", "Open incidents"]);
		expect(stats.items[0]?.value).toBe(30);
		expect(stats.items[1]?.value).toBe(15);
	});
});

describe("activity", () => {
	it("paginates with the filter carried in block_id", async () => {
		const first = await call({ type: "form_submit", action_id: "activity:filter", values: { filter: "origin:mcp" } });
		const table = first.res.blocks.find((b) => b.type === "table") as { rows: unknown[]; next_cursor?: string; block_id: string };
		expect(table.rows).toHaveLength(15);
		expect(table.block_id).toBe("activity:f:origin:mcp");
		const all = await call({ type: "page_load", page: "/activity" });
		const t1 = all.res.blocks.find((b) => b.type === "table") as { rows: unknown[]; next_cursor?: string };
		expect(t1.rows).toHaveLength(20);
		const next = await call({ type: "block_action", action_id: "activity:page", block_id: "activity:f:all", value: { cursor: t1.next_cursor } });
		const t2 = next.res.blocks.find((b) => b.type === "table") as { rows: unknown[] };
		expect(t2.rows).toHaveLength(10);
	});
	it("ignores unknown filters", async () => {
		const { res } = await call({ type: "form_submit", action_id: "activity:filter", values: { filter: "originSource:{$ne:1}" } });
		expect((res.blocks.find((b) => b.type === "table") as { block_id: string }).block_id).toBe("activity:f:all");
	});
	it("shows an event's details", async () => {
		const [id] = [...host.storage.events.rows.keys()];
		const { res } = await call({ type: "block_action", action_id: "activity:row", value: `detail|${id}` });
		valid(res);
		expect(text(res)).toContain("Fingerprint");
	});
});

describe("protected content", () => {
	it("protects an existing entry with a baseline and refuses unknown IDs", async () => {
		const ok = await call({ type: "form_submit", action_id: "protected:add", values: { collection: "pages", id: "p1", label: "Pricing", notes: "CTA matters", baseline: true } });
		valid(ok.res);
		expect(ok.used).toBeLessThanOrEqual(9);
		const r = (await host.storage.resources.get("pages:p1")) as ResourceState;
		expect(r).toMatchObject({ isProtected: true, label: "Pricing", notes: "CTA matters" });
		expect(r.baseline).toMatchObject({ domains: ["pay.example"], status: "published" });
		const bad = await call({ type: "form_submit", action_id: "protected:add", values: { collection: "pages", id: "missing" } });
		expect(bad.res.toast?.type).toBe("error");
		const inj = await call({ type: "form_submit", action_id: "protected:add", values: { collection: "pages:x", id: "p1" } });
		expect(inj.res.toast?.message).toContain("valid collection");
	});
	it("compares with the baseline and reports drift in plain language", async () => {
		await call({ type: "form_submit", action_id: "protected:add", values: { collection: "pages", id: "p1", baseline: true } });
		host.content.items.set("pages:p1", { id: "p1", slug: "pricing", status: "published", data: { title: "Pricing", cta: "https://pay.other.example/buy" } });
		const { res } = await call({ type: "block_action", action_id: "protected:row", value: "compare|pages:p1" });
		valid(res);
		expect(text(res)).toContain("changed since the known good state");
		expect(text(res)).toContain("pay.other.example");
	});
	it("unprotects and removes the baseline", async () => {
		await call({ type: "form_submit", action_id: "protected:add", values: { collection: "pages", id: "p1" } });
		await call({ type: "block_action", action_id: "protected:row", value: "unprotect|pages:p1" });
		const r = (await host.storage.resources.get("pages:p1")) as ResourceState;
		expect(r.isProtected).toBe(false);
		expect(r.baseline).toBeUndefined();
	});
	it("editor panel protects the current entry", async () => {
		const s = new Store(host);
		const res = await handlePanel(s, { input: { type: "block_action", action_id: "panel:protect" }, entry: { collection: "pages", id: "p1" }, userId: "admin1" });
		expect(s.budget.used).toBeLessThanOrEqual(9);
		expect(validateBlockResponse(res, POLICY).valid).toBe(true);
		expect(((await host.storage.resources.get("pages:p1")) as ResourceState).isProtected).toBe(true);
	});
});

describe("policies and settings (concurrency-safe)", () => {
	it("saves policies with the revision it rendered", async () => {
		const page = await call({ type: "page_load", page: "/policies" });
		const form = page.res.blocks.find((b) => b.type === "form") as { block_id: string };
		const saved = await call({ type: "form_submit", action_id: "policies:save", block_id: form.block_id, values: { mode: "monitor", "rule_protected-origin-mcp": "block", trusted: "Good.Example\nhttps://cdn.example/x", blocked: "evil.example" } });
		expect(saved.res.toast).toEqual({ type: "success", message: "Policies saved." });
		const c = normalizeConfig(await host.settings.get("config"));
		expect(c).toMatchObject({ mode: "monitor", trustedDomains: ["good.example", "cdn.example"], blockedDomains: ["evil.example"] });
		expect(c.rules["protected-origin-mcp"]).toBe("block");
	});
	it("rejects a stale form instead of overwriting another administrator's change", async () => {
		const page = await call({ type: "page_load", page: "/settings" });
		const form = page.res.blocks.find((b) => b.type === "form") as { block_id: string };
		await host.settings.set("config", { ...defaultConfig(), retentionDays: 90 });
		const saved = await call({ type: "form_submit", action_id: "settings:save", block_id: form.block_id, values: { retentionDays: "7" } });
		expect(saved.res.toast?.type).toBe("error");
		expect(normalizeConfig(await host.settings.get("config")).retentionDays).toBe(90);
	});
	it("validates settings values", async () => {
		const page = await call({ type: "page_load", page: "/settings" });
		const form = page.res.blocks.find((b) => b.type === "form") as { block_id: string };
		const bad = await call({ type: "form_submit", action_id: "settings:save", block_id: form.block_id, values: { shortThreshold: 1, alertsEnabled: true, alertEmail: "nope" } });
		expect(bad.res.toast?.type).toBe("error");
		const forged = await call({ type: "form_submit", action_id: "settings:save", block_id: "settings:r:forged", values: {} });
		expect(forged.res.toast?.type).toBe("error");
	});
	it("rejects invalid domains without saving anything", async () => {
		const page = await call({ type: "page_load", page: "/policies" });
		const form = page.res.blocks.find((b) => b.type === "form") as { block_id: string };
		const res = await call({ type: "form_submit", action_id: "policies:save", block_id: form.block_id, values: { blocked: "not a domain/..", mode: "monitor" } });
		expect(res.res.toast?.type).toBe("error");
		expect(normalizeConfig(await host.settings.get("config")).mode).toBe("enforce");
	});
	it("records ChangeWard's own configuration changes, flagging loosened policy", async () => {
		const page = await call({ type: "page_load", page: "/policies" });
		const form = page.res.blocks.find((b) => b.type === "form") as { block_id: string };
		await call({ type: "form_submit", action_id: "policies:save", block_id: form.block_id, values: { mode: "enforce", "rule_blocked-domain": "allow", trusted: "", blocked: "" } });
		const audit = [...host.storage.events.rows.values()].find((e) => e.action === "config.updated") as unknown as ChangeEvent;
		expect(audit).toMatchObject({ category: "system", originSource: "system", actorId: "admin1", severity: "low" });
		expect(audit.summary).toContain("blocked-domain block → allow");
		await call({ type: "form_submit", action_id: "protected:add", values: { collection: "pages", id: "p1" } });
		await call({ type: "block_action", action_id: "protected:row", value: "unprotect|pages:p1" });
		const actions = [...host.storage.events.rows.values()].map((e) => e.action);
		expect(actions).toEqual(expect.arrayContaining(["protection.added", "protection.removed"]));
	});

	it("refuses to grow a full domain list instead of silently dropping entries", async () => {
		const full = Array.from({ length: 200 }, (_, i) => `d${i}.example`);
		await host.settings.set("config", { ...defaultConfig(), blockedDomains: full });
		const res = await call({ type: "block_action", action_id: "policies:domain", value: "block|new.example" });
		expect(res.res.toast?.type).toBe("error");
		expect(normalizeConfig(await host.settings.get("config")).blockedDomains).toHaveLength(200);
	});

	it("classifies an observed domain from the table", async () => {
		await call({ type: "block_action", action_id: "policies:domain", value: "trust|Vendor.Example" });
		expect(normalizeConfig(await host.settings.get("config")).trustedDomains).toEqual(["vendor.example"]);
	});
});

describe("incidents", () => {
	async function seedIncident(status: Incident["status"] = "open"): Promise<string> {
		const now = new Date().toISOString();
		const inc: Incident = { id: "CW-2001", title: "t", status, severity: "medium", createdAt: now, updatedAt: now, lastEventAt: now, eventCount: 1, originSources: ["mcp"], actorIds: [], pluginIds: [], resourceKeys: ["pages:p1"], resourceLabels: [], protectedResourceKeys: [], domains: [], reasons: ["Opened by: x"], highEventCount: 0, originKeys: [], highProtectedKeys: [] };
		await host.storage.incidents.put(inc.id, inc);
		const ev = [...host.storage.events.rows.values()][0] as unknown as ChangeEvent;
		await host.storage.events.put(ev.id, { ...ev, incidentId: inc.id });
		return inc.id;
	}
	it("allows only documented transitions", () => {
		expect(canTransition("open", "resolved")).toBe(true);
		expect(canTransition("resolved", "investigating")).toBe(false);
		expect(canTransition("ignored", "open")).toBe(true);
	});
	it("shows the timeline and changes status without touching content", async () => {
		const id = await seedIncident();
		const detail = await call({ type: "block_action", action_id: "incidents:row", value: `view|${id}` });
		valid(detail.res);
		expect(text(detail.res)).toContain("Why these events are grouped");
		const contentBefore = JSON.stringify([...host.content.items.entries()]);
		const res = await call({ type: "block_action", action_id: "incidents:status", value: `${id}|resolved` });
		expect(res.used).toBeLessThanOrEqual(9);
		expect(res.res.toast?.message).toBe(`${id} marked resolved.`);
		expect(((await host.storage.incidents.get(id)) as Incident).status).toBe("resolved");
		expect(((await host.storage.incidents.get(id)) as Incident).statusChangedBy).toBe("admin1");
		expect(JSON.stringify([...host.content.items.entries()])).toBe(contentBefore);
		const invalid = await call({ type: "block_action", action_id: "incidents:status", value: `${id}|investigating` });
		expect(invalid.res.toast?.type).toBe("error");
	});
});
