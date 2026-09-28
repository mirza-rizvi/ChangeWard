import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../src/core/config";
import { Store } from "../src/core/store";
import type { ChangeEvent, Incident, ResourceState } from "../src/core/types";
import { runAlerts, runCleanup } from "../src/cron/tasks";
import { recordMediaUpload, scanRedirects } from "../src/events/observers";
import { recordContentChange, type ContentChange } from "../src/events/recorder";
import { parseState } from "../src/events/state";
import { decidePublication } from "../src/policies/decide";
import { fakeHost, type FakeHost } from "./support/fake-host";

let host: FakeHost;
const T0 = Date.parse("2026-09-29T10:00:00.000Z");

async function setConfig(patch: Partial<Config>) {
	await host.settings.set("config", { ...defaultConfig(), ...patch });
}
function events(): ChangeEvent[] {
	return [...host.storage.events.rows.values()].map((r) => r as unknown as ChangeEvent).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function incidents(): Incident[] {
	return [...host.storage.incidents.rows.values()] as unknown as Incident[];
}
async function protect(collection: string, id: string, label: string) {
	const r: ResourceState = { key: `${collection}:${id}`, collection, resourceId: id, isProtected: true, protectedAt: new Date(T0).toISOString(), label, lastSeenAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() };
	await host.storage.resources.put(r.key, r);
}
function item(id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return { id, slug: String(data.title ?? id).toLowerCase(), status: "draft", data, ...extra };
}
async function save(id: string, data: Record<string, unknown>, source: "mcp" | "visual-editor" | "api" = "visual-editor", now = T0, isNew = false) {
	const s = new Store(host);
	const change: ContentChange = {
		action: isNew ? "create" : "update",
		collection: "pages",
		resourceId: id,
		content: item(id, data),
		attribution: { source, actorId: "u1", actorRole: 50, actorSource: source },
	};
	await recordContentChange(s, change, now);
	return s.budget.used;
}

beforeEach(async () => {
	host = fakeHost();
	await setConfig({});
});

describe("change recording", () => {
	it("records origin, actor, hashes and intelligence within the bridge budget", async () => {
		const used = await save("p1", { title: "Pricing", cta: "https://pay.example/buy" }, "mcp", T0, true);
		expect(used).toBeLessThanOrEqual(9);
		const [e] = events();
		expect(e).toMatchObject({ category: "content", action: "content.created", originSource: "mcp", actorId: "u1", actorRole: 50, resourceKey: "pages:p1", resourceTitle: "Pricing", protectedResource: false });
		expect(e?.currentHash).toMatch(/^sha256:/);
		expect(e?.summary).toBe('"Pricing" created via MCP; new external domain (pay.example)');
		expect(e?.signals?.map((s) => s.code)).toContain("domain.new");
	});

	it("stores summaries, not content bodies or emails (data minimization)", async () => {
		const secret = "Customer list: alice@example.org, bob@example.org — confidential body text";
		await save("p1", { title: "Notes", body: secret, cta: "https://pay.example" }, "api", T0, true);
		const stored = JSON.stringify([...host.storage.events.rows.values(), ...host.storage.resources.rows.values(), ...host.kv.values.values()]);
		expect(stored).not.toContain("confidential body text");
		expect(stored).not.toContain("alice@example.org");
	});

	it("skips unchanged saves (autosave) instead of logging duplicates", async () => {
		await save("p1", { title: "A" }, "visual-editor", T0, true);
		await save("p1", { title: "A" }, "visual-editor", T0 + 1000);
		expect(events()).toHaveLength(1);
	});

	it("does not flood the log for entries that existed before installation", async () => {
		await save("old", { title: "Old", a: "https://one.example", b: "https://two.example" });
		expect(events()[0]?.signals?.map((s) => s.code)).toEqual(["analysis.first-seen"]);
	});

	it("raises protected-resource changes via MCP to medium and opens an incident", async () => {
		await protect("pages", "p1", "Pricing");
		await save("p1", { title: "Pricing", cta: "https://example.com" }, "mcp");
		const [e] = events();
		expect(e).toMatchObject({ protectedResource: true, severity: "medium" });
		expect(e?.summary.startsWith('Protected "Pricing" updated via MCP')).toBe(true);
		expect(e?.incidentId).toMatch(/^CW-\d+$/);
		expect(incidents()[0]).toMatchObject({ status: "open", severity: "medium", originSources: ["mcp"] });
	});

	it("records baseline drift on a protected resource once, then a return to baseline", async () => {
		await save("p1", { title: "Pricing", cta: "https://pay.example" }, "visual-editor", T0, true);
		const r = (await host.storage.resources.get("pages:p1")) as ResourceState;
		await host.storage.resources.put("pages:p1", { ...r, isProtected: true, baseline: { hash: r.lastHash, domains: ["pay.example"], status: "draft", capturedAt: "x" } });
		await save("p1", { title: "Pricing", cta: "https://pay2.example" }, "visual-editor", T0 + 1000);
		await save("p1", { title: "Pricing 2", cta: "https://pay2.example" }, "visual-editor", T0 + 2000);
		await save("p1", { title: "Pricing", cta: "https://pay.example" }, "visual-editor", T0 + 3000);
		const codes = events().map((e) => (e.signals ?? []).map((s) => s.code).filter((c) => c.startsWith("integrity")));
		expect(codes).toEqual([[], ["integrity.drift"], [], ["integrity.match"]]);
	});

	it("survives a compare-and-set conflict by re-reading state once", async () => {
		host.kv.failNextCas = 1;
		const used = await save("p1", { title: "A" }, "api", T0, true);
		expect(used).toBeLessThanOrEqual(9);
		expect(events()).toHaveLength(1);
		expect(parseState(await host.kv.get("state")).ring).toHaveLength(1);
	});

	it("still writes the event when state cannot be committed twice, without orphan incidents", async () => {
		await protect("pages", "p1", "Pricing");
		host.kv.failNextCas = 2;
		await save("p1", { title: "A" }, "mcp", T0);
		expect(events()).toHaveLength(1);
		expect(events()[0]?.incidentId).toBeUndefined();
		expect(incidents()).toHaveLength(0);
	});

	it("tolerates cached incidents stored in an older shape", async () => {
		await host.kv.set("state", { v: 1, ring: [], incidents: [{ id: "CW-9", lastEventAt: new Date(T0).toISOString(), resourceKeys: ["pages:p1"], status: "open", severity: "medium" }], observed: {}, bulk: {}, alerts: { pending: [] }, seq: 1000 });
		await protect("pages", "p1", "Pricing");
		await save("p1", { title: "A" }, "mcp", T0 + 1000);
		expect(events()[0]?.incidentId).toBe("CW-9");
	});

	it("a deferred after-hook cannot undo protection added while it ran (regression)", async () => {
		// The hook read the resource before it was protected, then writes its observation.
		const stale = new Store(host);
		await save("p1", { title: "Pricing" }, "api", T0, true);
		const before = (await host.storage.resources.get("pages:p1")) as ResourceState;
		await host.storage.resources.put("pages:p1", { ...before, isProtected: true, label: "Pricing", baseline: { hash: "h", domains: [], status: "draft", capturedAt: "x" } });
		await stale.observeResource({ ...before, isProtected: false, lastHash: "sha256:new" }, { lastHash: "sha256:new" });
		const after = (await host.storage.resources.get("pages:p1")) as ResourceState;
		expect(after).toMatchObject({ isProtected: true, label: "Pricing", lastHash: "sha256:new" });
		expect(after.baseline?.hash).toBe("h");
	});

	it("records deletes without inventing an origin", async () => {
		await protect("pages", "p1", "Legal");
		await recordContentChange(new Store(host), { action: "trash", collection: "pages", resourceId: "p1", attribution: { source: "unattributed" } }, T0);
		expect(events()[0]).toMatchObject({ action: "content.trashed", originSource: "unattributed", severity: "medium" });
		expect(((await host.storage.resources.get("pages:p1")) as ResourceState).deleted).toBe(true);
	});
});

describe("publication policy hook", () => {
	it("MCP publish of protected Pricing is rejected with an explained, recorded decision", async () => {
		await setConfig({ rules: { ...defaultConfig().rules, "protected-origin-mcp": "block" } });
		await protect("pages", "p1", "Pricing");
		const s = new Store(host);
		const d = await decidePublication(s, "publish", { content: item("p1", { title: "Pricing" }), collection: "pages", origin: { source: "mcp" }, actor: { id: "u1", role: 50, source: "mcp" } }, T0);
		expect(s.budget.used).toBeLessThanOrEqual(9);
		expect(d.result).toBe("block");
		expect(d.reason).toMatch(/^ChangeWard: Publishing protected resource "Pricing" via MCP/);
		expect(events()[0]).toMatchObject({ category: "policy", action: "policy.block", originSource: "mcp", severity: "high", protectedResource: true });
		expect(events()[0]?.policy?.[0]).toMatchObject({ rule: "protected-origin-mcp", result: "block" });
	});

	it("a BLOCK survives a storage failure while recording (review regression)", async () => {
		await setConfig({ blockedDomains: ["evil.example"] });
		host.kv.compareAndSet = async () => {
			throw new Error("D1 unavailable");
		};
		const d = await decidePublication(new Store(host), "publish", { content: item("p9", { title: "Post", a: "https://evil.example" }), collection: "pages", origin: { source: "api" } }, T0);
		expect(d.result).toBe("block");
		expect(host.logs.join(" ")).toContain("could not record a policy decision");
	});

	it("visual-editor publish is allowed; the after-hook inherits the origin", async () => {
		await setConfig({ rules: { ...defaultConfig().rules, "protected-origin-mcp": "block" } });
		await protect("pages", "p1", "Pricing");
		const d = await decidePublication(new Store(host), "publish", { content: item("p1", { title: "Pricing" }), collection: "pages", origin: { source: "visual-editor" }, actor: { id: "u9", role: 50, source: "visual-editor" } }, T0);
		expect(d.result).toBe("allow");
		expect(events()).toHaveLength(0);
		await recordContentChange(new Store(host), { action: "publish", collection: "pages", resourceId: "p1", content: item("p1", { title: "Pricing" }, { status: "published" }), attribution: { source: "unattributed" }, inheritFrom: "publish" }, T0 + 500);
		expect(events()[0]).toMatchObject({ action: "publication.published", originSource: "visual-editor", actorId: "u9", originInherited: true, protectedResource: true });
	});

	it("scheduled publication is attributed to the scheduler", async () => {
		await decidePublication(new Store(host), "publish", { content: item("p2", { title: "Launch" }), collection: "pages", origin: { source: "scheduler" } }, T0);
		await recordContentChange(new Store(host), { action: "publish", collection: "pages", resourceId: "p2", content: item("p2", { title: "Launch" }, { status: "published" }), attribution: { source: "unattributed" }, inheritFrom: "publish" }, T0 + 100);
		expect(events()[0]).toMatchObject({ originSource: "scheduler", severity: "info" });
		expect(incidents()).toHaveLength(0);
	});

	it("an after-hook with no matching decision stays unattributed", async () => {
		await recordContentChange(new Store(host), { action: "publish", collection: "pages", resourceId: "p3", content: item("p3", { title: "X" }), attribution: { source: "unattributed" }, inheritFrom: "publish" }, T0);
		expect(events()[0]?.originSource).toBe("unattributed");
	});

	it("compares the draft with live data: already-live domains are not 'introduced'", async () => {
		await protect("pages", "p1", "Pricing");
		const content = item("p1", { title: "Pricing", cta: "https://vendor.example" }, { liveData: { title: "Pricing", cta: "https://vendor.example" } });
		expect((await decidePublication(new Store(host), "publish", { content, collection: "pages", origin: { source: "api" } }, T0)).result).toBe("allow");
	});
});

describe("volume detection and correlation", () => {
	it("25 MCP edits in a minute produce one bulk-activity event and one incident", async () => {
		for (let i = 0; i < 25; i += 1) await save(`p${i}`, { title: `Doc ${i}` }, "mcp", T0 + i * 2000, true);
		const bulk = events().filter((e) => e.action === "activity.bulk");
		expect(bulk).toHaveLength(1);
		expect(bulk[0]).toMatchObject({ category: "activity", originSource: "mcp", severity: "medium" });
		expect(bulk[0]?.summary).toMatch(/^Unusual change volume via MCP: 20 changes in 60 s/);
		expect(JSON.stringify(bulk)).not.toMatch(/attack/i);
		expect(incidents()).toHaveLength(1);
		// Later MCP edits by the same actor join the incident (same origin and actor).
		expect(events().filter((e) => e.incidentId).length).toBeGreaterThan(1);
	});

	it("a normal editor pace does not trip volume detection", async () => {
		for (let i = 0; i < 10; i += 1) await save(`p${i}`, { title: `Doc ${i}` }, "visual-editor", T0 + i * 30_000, true);
		expect(events().filter((e) => e.action === "activity.bulk")).toHaveLength(0);
	});

	it("correlates an MCP edit, new domain and blocked publication into one incident with reasons", async () => {
		await setConfig({ blockedDomains: ["pay.evil.example"] });
		await protect("pages", "pricing", "Pricing");
		await save("pricing", { title: "Pricing", cta: "https://example.com" }, "mcp", T0);
		await save("pricing", { title: "Pricing", cta: "https://pay.evil.example/checkout" }, "mcp", T0 + 30_000);
		await decidePublication(new Store(host), "publish", { content: item("pricing", { title: "Pricing", cta: "https://pay.evil.example/checkout" }), collection: "pages", origin: { source: "mcp" }, actor: { id: "u1", role: 50, source: "mcp" } }, T0 + 60_000);
		const inc = incidents();
		expect(inc).toHaveLength(1);
		expect(inc[0]).toMatchObject({ severity: "high", eventCount: 3, domains: ["pay.evil.example"], protectedResourceKeys: ["pages:pricing"] });
		expect(inc[0]?.reasons.join(" | ")).toContain("Same resource (Pricing)");
		expect(new Set(events().map((e) => e.incidentId)).size).toBe(1);
	});

	it("escalates to critical when high-severity changes hit two protected resources", async () => {
		await setConfig({ blockedDomains: ["evil.example"] });
		await protect("pages", "a", "Pricing");
		await protect("pages", "b", "Downloads");
		await save("a", { title: "Pricing", x: "https://evil.example/1" }, "mcp", T0);
		await save("b", { title: "Downloads", x: "https://evil.example/2" }, "mcp", T0 + 10_000);
		expect(incidents()).toHaveLength(1);
		expect(incidents()[0]?.severity).toBe("critical");
	});

	it("unrelated low-severity changes do not create incidents", async () => {
		await save("a", { title: "A", x: "https://one.example" }, "visual-editor", T0, true);
		await save("b", { title: "B", x: "https://two.example" }, "api", T0 + 1000, true);
		expect(incidents()).toHaveLength(0);
	});

	it("activity after the correlation window starts a new incident", async () => {
		await protect("pages", "p1", "Pricing");
		await save("p1", { title: "Pricing", v: 1 }, "mcp", T0);
		await save("p1", { title: "Pricing", v: 2 }, "mcp", T0 + 11 * 60_000);
		expect(incidents()).toHaveLength(2);
	});
});

describe("observers and cron", () => {
	it("records media metadata observations", async () => {
		await recordMediaUpload(new Store(host), { id: "m1", filename: "invoice.pdf.exe", mimeType: "application/octet-stream", size: 10 }, T0);
		expect(events()[0]).toMatchObject({ category: "media", severity: "medium", resourceTitle: "invoice.pdf.exe" });
	});

	it("redirect scan: first run captures, later runs report net changes", async () => {
		host.redirects.rules = [{ id: "r1", source: "/pricing", destination: "/plans", type: 301, enabled: true }];
		expect(await scanRedirects(new Store(host), T0)).toEqual({ changes: 0, partial: false });
		host.redirects.rules = [{ id: "r1", source: "/pricing", destination: "https://pay.other.example/", type: 301, enabled: true }];
		const s = new Store(host);
		expect(await scanRedirects(s, T0 + 900_000)).toEqual({ changes: 1, partial: false });
		expect(s.budget.used).toBeLessThanOrEqual(9);
		expect(events()[0]).toMatchObject({ category: "redirect", action: "redirect.changed", originSource: "unattributed", severity: "medium" });
		expect(events()[0]?.summary).toContain("observed by periodic check");
	});

	it("redirect scan marks snapshots partial beyond the page budget", async () => {
		host.redirects.rules = Array.from({ length: 250 }, (_, i) => ({ id: `r${i}`, source: `/s${i}`, destination: "/d", type: 301, enabled: true }));
		expect((await scanRedirects(new Store(host), T0))?.partial).toBe(true);
	});

	it("retention removes expired events, closed incidents and stale unprotected resources only", async () => {
		const old = new Date(T0 - 40 * 86_400_000).toISOString();
		const recent = new Date(T0 - 86_400_000).toISOString();
		await host.storage.events.put("old", { id: "old", createdAt: old });
		await host.storage.events.put("new", { id: "new", createdAt: recent });
		await host.storage.incidents.put("CW-1", { id: "CW-1", status: "resolved", updatedAt: new Date(T0 - 200 * 86_400_000).toISOString() });
		await host.storage.incidents.put("CW-2", { id: "CW-2", status: "open", updatedAt: new Date(T0 - 200 * 86_400_000).toISOString() });
		await host.storage.resources.put("pages:a", { key: "pages:a", isProtected: false, lastSeenAt: old });
		await host.storage.resources.put("pages:b", { key: "pages:b", isProtected: true, lastSeenAt: old });
		const s = new Store(host);
		expect(await runCleanup(s, T0)).toEqual({ events: 1, incidents: 1, resources: 1 });
		expect(s.budget.used).toBeLessThanOrEqual(9);
		expect([...host.storage.events.rows.keys()]).toEqual(["new"]);
		expect([...host.storage.incidents.rows.keys()]).toEqual(["CW-2"]);
		expect([...host.storage.resources.rows.keys()]).toEqual(["pages:b"]);
	});

	it("alerts: one digest email, cooldown respected, nothing when disabled", async () => {
		await protect("pages", "p1", "Pricing");
		await setConfig({ blockedDomains: ["evil.example"], alerts: { enabled: true, email: "ops@mysite.example", minSeverity: "high", cooldownMin: 30 } });
		await save("p1", { title: "Pricing", x: "https://evil.example" }, "mcp", T0);
		expect(await runAlerts(new Store(host), T0 + 60_000)).toBe(1);
		expect(host.email.sent).toHaveLength(1);
		expect(host.email.sent[0]?.subject).toBe("[ChangeWard] 1 incident(s) need review on My Site");
		expect(host.email.sent[0]?.text).not.toMatch(/malware|attack|compromised/i);
		await protect("pages", "p2", "Legal");
		await save("p2", { title: "Legal", x: "https://evil.example/2" }, "api", T0 + 20 * 60_000);
		expect(await runAlerts(new Store(host), T0 + 21 * 60_000)).toBe(0);
		expect(await runAlerts(new Store(host), T0 + 61 * 60_000)).toBe(1);
	});
});
