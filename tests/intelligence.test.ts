import { describe, expect, it } from "vitest";
import { classifyChange, snapshotFromStored, snapshotOf, storedRefs } from "../src/intelligence/classify-change";
import { classifyDomain, matchesDomain, normalizeDomainEntry, normalizeUrl } from "../src/intelligence/domains";
import { mediaSignals } from "../src/intelligence/media";
import { diffRedirects, type RedirectSnapshot } from "../src/intelligence/redirects";
import { externalHosts, extract } from "../src/intelligence/urls";

const SITE = "www.mysite.example";
const codes = (a: { signals: Array<{ code: string }> }) => a.signals.map((s) => s.code);
const opts = { trusted: [] as string[], blocked: [] as string[], observed: new Set<string>() };

describe("URL normalization", () => {
	it("lowercases hosts, drops default ports and fragments", () => {
		expect(normalizeUrl("HTTPS://Example.COM:443/a#frag", SITE)).toMatchObject({ href: "https://example.com/a", host: "example.com", scheme: "https", external: true });
	});
	it("converts IDN hosts to punycode and flags them", () => {
		const n = normalizeUrl("https://bücher.example/", SITE);
		expect(n?.host).toBe("xn--bcher-kva.example");
		expect(n?.punycode).toBe(true);
	});
	it("treats relative and same-site URLs as internal", () => {
		expect(normalizeUrl("/pricing", SITE)).toMatchObject({ scheme: "relative", external: false });
		expect(normalizeUrl("https://mysite.example/x", SITE)?.external).toBe(false);
		expect(normalizeUrl("//cdn.other.example/x.js", SITE)).toMatchObject({ host: "cdn.other.example", external: true });
	});
	it("detects obfuscated javascript: schemes the way browsers parse them", () => {
		expect(normalizeUrl(" java\tscript:alert(1)", SITE)?.scheme).toBe("javascript");
		expect(normalizeUrl("JAVASCRIPT:void(0)", SITE)?.scheme).toBe("javascript");
	});
	it("never stores the payload of script or data URLs", () => {
		const n = normalizeUrl(`data:text/html;base64,${"A".repeat(500)}`, SITE);
		expect(n?.scheme).toBe("data");
		expect(n?.href.length).toBeLessThan(50);
	});
	it("flags IP literals", () => {
		expect(normalizeUrl("http://192.168.1.10/x", SITE)?.ipLiteral).toBe(true);
		expect(normalizeUrl("http://[::1]/x", SITE)?.ipLiteral).toBe(true);
	});
	it("returns undefined for unparseable input", () => {
		expect(normalizeUrl("http://", SITE)).toBeUndefined();
	});
});

describe("domain lists", () => {
	it("normalizes administrator entries", () => {
		expect(normalizeDomainEntry("  Example.COM ")).toBe("example.com");
		expect(normalizeDomainEntry("https://pay.example/checkout")).toBe("pay.example");
		expect(normalizeDomainEntry("*.cdn.example")).toBe("cdn.example");
		expect(normalizeDomainEntry("bücher.example")).toBe("xn--bcher-kva.example");
		for (const bad of ["", "localhost", "1.2.3.4", "a b.example", "exa mple", "foo/bar", "user@host.example"]) expect(normalizeDomainEntry(bad)).toBeUndefined();
	});
	it("matches subdomains but not look-alike suffixes", () => {
		expect(matchesDomain("cdn.example.com", "example.com")).toBe(true);
		expect(matchesDomain("example.com", "example.com")).toBe(true);
		expect(matchesDomain("badexample.com", "example.com")).toBe(false);
	});
	it("classifies blocked before trusted, then observed, then new", () => {
		const lists = { trusted: ["example.com"], blocked: ["evil.example.com"] };
		expect(classifyDomain("evil.example.com", lists, new Set()).status).toBe("blocked");
		expect(classifyDomain("www.example.com", lists, new Set()).status).toBe("trusted");
		expect(classifyDomain("seen.example", lists, new Set(["seen.example"])).status).toBe("observed");
		expect(classifyDomain("fresh.example", lists, new Set()).status).toBe("new");
	});
	it("reports punycode as an observation, not a verdict", () => {
		const c = classifyDomain("xn--pple-43d.example", { trusted: [], blocked: [] }, new Set());
		expect(c).toMatchObject({ status: "new", punycode: true });
	});
});

describe("extraction", () => {
	it("reads Portable Text link marks and URL fields", () => {
		const x = extract(
			{
				cta: "https://pay.example/checkout",
				body: [{ _type: "block", children: [{ _type: "span", text: "hi", marks: ["l"] }], markDefs: [{ _key: "l", _type: "link", href: "https://vendor.example/a" }] }],
			},
			SITE,
		);
		expect(externalHosts(x).sort()).toEqual(["pay.example", "vendor.example"]);
		expect(x.urlFields).toEqual({ cta: "pay.example" });
	});
	it("finds script, iframe, form targets and inline handlers in HTML strings", () => {
		const x = extract({ html: `<p onclick="x()">a</p><script src="https://cdn.bad.example/s.js"></script><script>1</script><iframe src='https://frame.example/'></iframe><form action=https://collect.example/post>` }, SITE);
		const kinds = x.refs.map((r) => `${r.kind}:${r.host}`);
		expect(kinds).toEqual(expect.arrayContaining(["script:cdn.bad.example", "iframe:frame.example", "form:collect.example"]));
		expect(x.inlineScripts).toBe(1);
		expect(x.inlineHandlers).toBe(1);
	});
	it("finds URLs in plain text", () => {
		expect(externalHosts(extract({ body: "see https://docs.example/x and more" }, SITE))).toEqual(["docs.example"]);
	});
	it("marks embed-type blocks but not code blocks", () => {
		expect(extract({ body: [{ _type: "embed", url: "https://video.example/1" }, { _type: "code", code: "<script>" }] }, SITE).embedBlocks).toEqual(["embed"]);
	});
	it("is bounded: huge input is marked partial instead of processed", () => {
		const links = Array.from({ length: 400 }, (_, i) => `https://h${i}.example/`).join(" ");
		expect(extract({ body: links }, SITE).partial).toBe(true);
		expect(extract({ body: "x".repeat(300_000) }, SITE).partial).toBe(true);
		let deep: unknown = "https://deep.example";
		for (let i = 0; i < 50; i += 1) deep = { a: deep };
		expect(extract(deep, SITE).partial).toBe(true);
	});
	it("does not follow cycles forever", () => {
		const a: Record<string, unknown> = { href: "https://a.example" };
		a.self = a;
		expect(extract(a, SITE).partial).toBe(true);
	});
});

describe("change intelligence", () => {
	it("reports a new domain as an observation, never as malware", () => {
		const before = snapshotOf(extract({ cta: "https://example.com/buy" }, SITE));
		const a = classifyChange(before, extract({ cta: "https://newvendor.example/buy" }, SITE), opts);
		expect(codes(a)).toEqual(expect.arrayContaining(["domain.new", "domain.removed", "url.changed"]));
		expect(JSON.stringify(a)).not.toMatch(/malware|attack|compromis|hacker/i);
	});
	it("flags blocked, http, javascript: and data: introductions", () => {
		const a = classifyChange(null, extract({ a: "https://evil.example/", b: "http://plain.example/", c: '<a href="javascript:alert(1)">x</a>', d: '<iframe src="data:text/html,hi">' }, SITE), { ...opts, blocked: ["evil.example"] });
		expect(codes(a)).toEqual(expect.arrayContaining(["domain.blocked", "url.http", "url.javascript", "url.data"]));
	});
	it("ignores data: images", () => {
		const a = classifyChange(null, extract({ img: '<img src="data:image/png;base64,AAAA">' }, SITE), opts);
		expect(codes(a)).not.toContain("url.data");
	});
	it("reports nothing new when content is unchanged", () => {
		const data = { body: '<script src="https://cdn.example/x.js"></script>', cta: "https://a.example" };
		const a = classifyChange(snapshotOf(extract(data, SITE)), extract(data, SITE), opts);
		expect(codes(a)).toEqual([]);
	});
	it("first observation of an existing entry only reports blocked domains and dangerous schemes", () => {
		const a = classifyChange(null, extract({ a: "https://x.example", b: "https://evil.example", c: "javascript:alert(1)" }, SITE), { ...opts, blocked: ["evil.example"], firstSeen: true });
		expect(codes(a).sort()).toEqual(["analysis.first-seen", "domain.blocked", "url.javascript"]);
	});
	it("flags many new outbound links", () => {
		const body = Array.from({ length: 25 }, (_, i) => `https://l${i}.example/`).join(" ");
		expect(codes(classifyChange(snapshotOf(extract({}, SITE)), extract({ body }, SITE), opts))).toContain("links.many");
	});
	it("round-trips through the stored snapshot form", () => {
		const x = extract({ body: '<script src="https://cdn.example/x.js"></script> https://a.example/', cta: "https://pay.example" }, SITE);
		const restored = snapshotFromStored(storedRefs(x), x.urlFields, { inlineScripts: 0, inlineHandlers: 0, embedBlocks: [] }, SITE);
		expect(codes(classifyChange(restored, x, opts))).toEqual([]);
	});
});

describe("media observations", () => {
	it("flags SVG, HTML, executables and double extensions from metadata only", () => {
		expect(mediaSignals("logo.svg", "image/svg+xml").map((s) => s.code)).toEqual(["media.svg"]);
		expect(mediaSignals("invoice.pdf.exe", "application/octet-stream").map((s) => s.code)).toEqual(["media.executable"]);
		expect(mediaSignals("photo.php.jpg", "image/jpeg").map((s) => s.code)).toEqual(["media.double-extension"]);
		expect(mediaSignals("page.html", "text/html").map((s) => s.code)).toEqual(["media.html"]);
		expect(mediaSignals("photo.jpg", "image/jpeg")).toEqual([]);
	});
});

describe("redirect diff", () => {
	const snap = (rules: RedirectSnapshot["rules"], partial = false): RedirectSnapshot => ({ takenAt: "t", rules, partial });
	const rule = (id: string, source: string, destination: string) => ({ id, source, destination, type: 301, enabled: true });
	it("detects added, changed, internal→external, blocked and removed rules", () => {
		const prev = snap([rule("1", "/pricing", "/plans"), rule("2", "/old", "/new")]);
		const next = snap([rule("1", "/pricing", "http://pay.evil.example/"), rule("3", "/x", "/y")]);
		const changes = diffRedirects(prev, next, SITE, ["evil.example"]);
		expect(changes.map((c) => c.kind).sort()).toEqual(["added", "changed", "removed"]);
		const changed = changes.find((c) => c.kind === "changed");
		expect(changed?.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["redirect.changed", "redirect.external", "redirect.blocked", "redirect.http"]));
	});
	it("does not report removals when a snapshot is partial", () => {
		expect(diffRedirects(snap([rule("1", "/a", "/b")]), snap([], true), SITE, [])).toEqual([]);
	});
});
