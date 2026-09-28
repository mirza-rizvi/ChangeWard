import { describe, expect, it } from "vitest";
import { defaultConfig, normalizeConfig, type Config } from "../src/core/config";
import { eventSeverity, maxSeverity } from "../src/core/severity";
import type { Attribution } from "../src/core/types";
import { attributionFromActor, attributionFromPolicy, originLabel, viaPhrase } from "../src/events/origin";
import { classifyChange, snapshotOf } from "../src/intelligence/classify-change";
import { extract } from "../src/intelligence/urls";
import { clampReason, evaluatePolicies } from "../src/policies/engine";

const SITE = "www.mysite.example";
const mcp: Attribution = { source: "mcp", actorId: "u1", actorRole: 50, actorSource: "mcp" };
const editor: Attribution = { source: "visual-editor", actorId: "u1", actorRole: 50 };

function analysis(before: Record<string, unknown> | null, after: Record<string, unknown>, cfg: Config) {
	return classifyChange(before ? snapshotOf(extract(before, SITE)) : null, extract(after, SITE), { trusted: cfg.trustedDomains, blocked: cfg.blockedDomains, observed: new Set() });
}

describe("origin attribution", () => {
	it("uses the policy event origin and plugin ID", () => {
		expect(attributionFromPolicy({ source: "plugin", pluginId: "seo-tools" }, undefined)).toEqual({ source: "plugin", pluginId: "seo-tools" });
		expect(attributionFromPolicy({ source: "scheduler" }, undefined)).toEqual({ source: "scheduler" });
		expect(attributionFromPolicy({ source: "mcp" }, { id: "u1", role: 50, source: "mcp" })).toEqual(mcp);
	});
	it("keeps unknown future origins without trusting them", () => {
		expect(attributionFromPolicy({ source: "webmcp-agent" }, undefined)).toEqual({ source: "unknown", rawSource: "webmcp-agent" });
		expect(attributionFromPolicy({ source: "<script>" }, undefined)).toEqual({ source: "unknown" });
		expect(attributionFromPolicy(undefined, undefined).source).toBe("unattributed");
	});
	it("derives save origin from actor.source only, never guesses", () => {
		expect(attributionFromActor({ id: "u1", role: 50, source: "visual-editor" }).source).toBe("visual-editor");
		expect(attributionFromActor({ id: "u1", role: 50 }).source).toBe("unattributed");
		expect(attributionFromActor(undefined)).toEqual({ source: "unattributed" });
	});
	it("says MCP, not AI", () => {
		expect(originLabel(mcp)).toBe("MCP");
		expect(viaPhrase(mcp)).toBe("via MCP");
		expect(`${originLabel(mcp)} ${viaPhrase(mcp)}`).not.toMatch(/\bAI\b|agent/i);
	});
	it("rejects malformed actor IDs", () => {
		expect(attributionFromActor({ id: "x".repeat(500), role: 1, source: "api" }).actorId).toBeUndefined();
	});
});

describe("severity model", () => {
	const sev = (codes: string[], protectedResource = false, origin: Attribution["source"] = "visual-editor", action = "edit") =>
		eventSeverity({ signals: codes.map((code) => ({ code: code as never })), protectedResource, origin, action });
	it("follows the documented table", () => {
		expect(sev([])).toBe("info");
		expect(sev(["domain.new"])).toBe("low");
		expect(sev([], true)).toBe("low");
		expect(sev([], true, "mcp")).toBe("medium");
		expect(sev([], true, "visual-editor", "delete")).toBe("medium");
		expect(sev(["domain.blocked"])).toBe("medium");
		expect(sev(["domain.blocked"], true)).toBe("high");
		expect(sev(["url.javascript"])).toBe("high");
		expect(sev(["embed.iframe"], true, "mcp", "publish")).toBe("high");
	});
	it("never returns critical for a single event", () => {
		expect(sev(["url.javascript", "domain.blocked", "embed.script", "volume.bulk"], true, "mcp", "publish")).toBe("high");
	});
	it("maxSeverity picks the highest", () => {
		expect(maxSeverity("low", "high", "medium")).toBe("high");
	});
});

describe("publication policies", () => {
	const cfg = (patch: Partial<Config> = {}): Config => ({ ...defaultConfig(), ...patch });

	it("MCP publish of protected content: rejected with a clear reason when configured to block", () => {
		const c = cfg({ rules: { ...defaultConfig().rules, "protected-origin-mcp": "block" } });
		const d = evaluatePolicies({ action: "publish", attribution: mcp, protectedResource: true, label: "Pricing", analysis: analysis({}, {}, c), config: c });
		expect(d.result).toBe("block");
		expect(d.reason).toContain('protected resource "Pricing" via MCP');
		expect(d.reason).toContain("protected-origin-mcp");
		expect(d.reason?.length).toBeLessThanOrEqual(500);
	});
	it("visual-editor publish of the same protected content is allowed", () => {
		const c = cfg({ rules: { ...defaultConfig().rules, "protected-origin-mcp": "block" } });
		expect(evaluatePolicies({ action: "publish", attribution: editor, protectedResource: true, label: "Pricing", analysis: analysis({}, {}, c), config: c }).result).toBe("allow");
	});
	it("API publish of protected content follows its own rule", () => {
		const c = cfg({ rules: { ...defaultConfig().rules, "protected-origin-api": "warn" } });
		const d = evaluatePolicies({ action: "publish", attribution: { source: "api" }, protectedResource: true, label: "Pricing", analysis: analysis({}, {}, c), config: c });
		expect(d.result).toBe("warn");
		expect(d.reason).toBeUndefined();
	});
	it("blocks blocked domains on any content by default", () => {
		const c = cfg({ blockedDomains: ["evil.example"] });
		const d = evaluatePolicies({ action: "publish", attribution: editor, protectedResource: false, label: "Post", analysis: analysis(null, { link: "https://x.evil.example/" }, c), config: c });
		expect(d.result).toBe("block");
		expect(d.reason).toContain("x.evil.example");
	});
	it("blocks an introduced javascript: URL by default", () => {
		const c = cfg();
		const d = evaluatePolicies({ action: "publish", attribution: editor, protectedResource: false, label: "Post", analysis: analysis({ body: "" }, { body: '<a href="javascript:steal()">x</a>' }, c), config: c });
		expect(d.result).toBe("block");
		expect(d.outcomes[0]?.rule).toBe("dangerous-scheme");
	});
	it("warns (does not block) when protected content introduces an unknown domain or http link", () => {
		const c = cfg();
		const d = evaluatePolicies({ action: "publish", attribution: editor, protectedResource: true, label: "Pricing", analysis: analysis({ cta: "https://example.com" }, { cta: "http://newvendor.example" }, c), config: c });
		expect(d.result).toBe("warn");
		expect(d.outcomes.map((o) => o.rule).sort()).toEqual(["protected-insecure-http", "protected-unknown-domain"]);
		expect(d.outcomes.find((o) => o.rule === "protected-unknown-domain")?.reason).toContain("untrusted domain newvendor.example");
	});
	it("trusted domains do not trigger the unknown-domain rule", () => {
		const c = cfg({ trustedDomains: ["newvendor.example"] });
		const d = evaluatePolicies({ action: "publish", attribution: editor, protectedResource: true, label: "Pricing", analysis: analysis({}, { cta: "https://newvendor.example" }, c), config: c });
		expect(d.result).toBe("allow");
	});
	it("unknown domains on ordinary content are allowed", () => {
		const c = cfg();
		expect(evaluatePolicies({ action: "publish", attribution: mcp, protectedResource: false, label: "Post", analysis: analysis(null, { a: "https://unknown.example" }, c), config: c }).result).toBe("allow");
	});
	it("monitor mode records BLOCK as WARN", () => {
		const c = cfg({ mode: "monitor", blockedDomains: ["evil.example"] });
		const d = evaluatePolicies({ action: "publish", attribution: editor, protectedResource: false, label: "Post", analysis: analysis(null, { a: "https://evil.example" }, c), config: c });
		expect(d).toMatchObject({ result: "warn", downgraded: true });
	});
	it("warns when protected content is unpublished", () => {
		const c = cfg();
		expect(evaluatePolicies({ action: "unpublish", attribution: editor, protectedResource: true, label: "Legal", config: c }).outcomes.map((o) => o.rule)).toEqual(["protected-unpublish"]);
	});
	it("scheduler re-checks content rules but no origin rule applies", () => {
		const c = cfg({ rules: { ...defaultConfig().rules, "protected-origin-mcp": "block" } });
		expect(evaluatePolicies({ action: "publish", attribution: { source: "scheduler" }, protectedResource: true, label: "Pricing", analysis: analysis({}, {}, c), config: c }).result).toBe("allow");
	});
	it("partial analysis on protected content is flagged, never silently allowed", () => {
		const c = cfg();
		const body = Array.from({ length: 400 }, (_, i) => `https://l${i}.example/`).join(" ");
		const d = evaluatePolicies({ action: "publish", attribution: editor, protectedResource: true, label: "Docs", analysis: { ...analysis({}, { body }, c) }, config: { ...c, rules: { ...c.rules, "protected-unknown-domain": "allow" } } });
		expect(d.outcomes.map((o) => o.rule)).toContain("analysis-partial");
		expect(d.result).toBe("warn");
	});
	it("clamps reasons to EmDash's 500-character plain-text limit", () => {
		const r = clampReason(`a\nb${"x".repeat(900)}`);
		expect(r.length).toBe(500);
		expect(r).not.toContain("\n");
	});
});

describe("config normalization", () => {
	it("falls back to defaults for invalid stored values", () => {
		const c = normalizeConfig({ mode: "yolo", rules: { "blocked-domain": "explode" }, retentionDays: 3, trustedDomains: ["Good.Example", "bad domain"], alerts: { email: "not-an-email", enabled: "true" } });
		expect(c.mode).toBe("enforce");
		expect(c.rules["blocked-domain"]).toBe("block");
		expect(c.retentionDays).toBe(30);
		expect(c.trustedDomains).toEqual(["good.example"]);
		expect(c.alerts).toMatchObject({ email: "", enabled: true });
	});
});
