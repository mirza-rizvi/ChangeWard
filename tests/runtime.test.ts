import { afterEach, describe, expect, it } from "vitest";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import type { ChangeEvent, Incident, ResourceState } from "../src/core/types";

/**
 * Production-boundary tests: the built bundle runs in the sandbox runner behind the real
 * capability bridge, with EmDash's own content actions, storage and Block Kit validation.
 */
let host: PluginRuntimeTestHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await read();
		if (ok(v) || Date.now() - start > ms) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function setup() {
	host = await createPluginRuntimeTestHost({ site: { name: "Test", url: "https://www.mysite.example" } });
	await host.fixtures.collection({
		slug: "pages",
		label: "Pages",
		supports: ["drafts", "revisions"] as never,
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "cta", label: "CTA", type: "url" },
		],
	});
	const admin = await host.fixtures.user({ email: "admin@mysite.example", role: "admin" });
	return { h: host, admin };
}

const events = async (h: PluginRuntimeTestHost) => (await h.inspect.storage.list<ChangeEvent>("events")).map((x) => x.data);

describe("runtime contract", () => {
	it("declares exactly the least-privilege capabilities and no network hosts", async () => {
		const { h } = await setup();
		expect([...h.manifest.capabilities].sort()).toEqual(["content:read", "email:send", "hooks.content-policy:register", "media:read", "redirects:read"]);
		expect(h.manifest.allowedHosts ?? []).toEqual([]);
		expect(h.manifest.capabilities).not.toContain("content:write");
		expect(h.manifest.capabilities).not.toContain("content:publish");
		expect(h.manifest.capabilities).not.toContain("network:request:unrestricted");
		expect(h.manifest.capabilities).not.toContain("users:read");
	});

	it("records an MCP save with its real origin and actor", async () => {
		const { h, admin } = await setup();
		const res = await h.actions.content.create("pages", { data: { title: "Pricing", cta: "https://pay.example/x" }, slug: "pricing", actor: { id: admin.id, role: 50, source: "mcp" } } as never);
		expect((res as { success: boolean }).success).toBe(true);
		const [e] = await until(() => events(h), (v) => v.length > 0);
		expect(e).toMatchObject({ action: "content.created", originSource: "mcp", actorId: admin.id, resourceTitle: "Pricing" });
		expect(e?.signals?.map((s) => s.code)).toContain("domain.new");
	});

	it("blocks MCP publication of protected content with a clear reason and allows the visual editor", async () => {
		const { h, admin } = await setup();
		const created = (await h.actions.content.create("pages", { data: { title: "Pricing", cta: "https://pay.example/x" }, slug: "pricing" } as never)) as { data: { item: { id: string } } };
		const id = created.data.item.id;

		const added = await h.admin.submit("/protected", "protected:add", { collection: "pages", id, label: "Pricing", baseline: true }, { user: admin as never });
		expect(added.toast?.type).toBe("success");
		const policies = await h.admin.loadPage("/policies", { user: admin as never });
		const form = policies.blocks.find((b) => b.type === "form") as { block_id: string };
		const values: Record<string, unknown> = { mode: "enforce", "rule_protected-origin-mcp": "block", trusted: "", blocked: "" };
		const saved = await h.admin.submit("/policies", "policies:save", values, { user: admin as never, blockId: form.block_id });
		expect(saved.toast?.type).toBe("success");

		const rejected = (await h.actions.content.publish("pages", id, { origin: { source: "mcp" }, actor: { id: admin.id, role: 50, source: "mcp" } } as never)) as { success: boolean; error?: { code: string; message: string } };
		expect(rejected.success).toBe(false);
		expect(rejected.error?.code).toBe("PUBLISH_REJECTED");
		expect(rejected.error?.message).toContain('Publishing protected resource "Pricing" via MCP');
		expect((await h.inspect.content.get("pages", id))?.status).not.toBe("published");

		const allowed = (await h.actions.content.publish("pages", id, { origin: { source: "visual-editor" }, actor: { id: admin.id, role: 50, source: "visual-editor" } } as never)) as { success: boolean };
		expect(allowed.success).toBe(true);
		const all = await until(() => events(h), (v) => v.some((e) => e.action === "publication.published"));
		expect(all.find((e) => e.action === "policy.block")).toMatchObject({ originSource: "mcp", protectedResource: true });
		expect(all.find((e) => e.action === "publication.published")).toMatchObject({ originSource: "visual-editor", originInherited: true, protectedResource: true });
		const incidents = (await h.inspect.storage.list<Incident>("incidents")).map((x) => x.data);
		expect(incidents.length).toBeGreaterThan(0);
	});

	it("renders every admin page and widget through the host's Block Kit validation", async () => {
		const { h, admin } = await setup();
		await h.actions.content.create("pages", { data: { title: "A" }, slug: "a" } as never);
		for (const p of ["/overview", "/activity", "/incidents", "/protected", "/policies", "/settings"]) {
			const res = await h.admin.loadPage(p, { user: admin as never });
			expect(res.blocks.length).toBeGreaterThan(1);
			expect(JSON.stringify(res)).not.toContain("could not");
		}
		for (const w of ["status", "incidents"]) expect((await h.admin.loadWidget(w, { user: admin as never })).blocks.length).toBeGreaterThan(0);
	});

	it("schedules its cron tasks on activation and seeds config on install", async () => {
		const { h } = await setup();
		await h.actions.plugin.activate();
		const names = (await h.inspect.scheduledTasks()).map((t) => String(t.name ?? t.taskName ?? ""));
		expect(names.join(",")).toMatch(/changeward-cleanup/);
		const r = await h.inspect.storage.list<ResourceState>("resources");
		expect(Array.isArray(r)).toBe(true);
	});
});
