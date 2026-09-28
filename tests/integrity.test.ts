import { describe, expect, it } from "vitest";
import { compareToBaseline, describeDrift, makeBaseline } from "../src/integrity/baseline";
import { canonicalize } from "../src/integrity/canonicalize";
import { fingerprint, sha256Hex } from "../src/integrity/hash";

describe("canonicalization", () => {
	it("is independent of key order and Portable Text _key values", () => {
		const a = canonicalize({ b: 1, a: [{ _key: "x1", text: "hi" }] });
		const b = canonicalize({ a: [{ text: "hi", _key: "zz" }], b: 1 });
		expect(a.text).toBe(b.text);
	});
	it("normalizes Unicode to NFC and line endings to LF", () => {
		expect(canonicalize({ t: "é\r\nx" }).text).toBe(canonicalize({ t: "é\nx" }).text);
	});
	it("keeps array order and distinguishes types", () => {
		expect(canonicalize([1, 2]).text).not.toBe(canonicalize([2, 1]).text);
		expect(canonicalize({ a: "1" }).text).not.toBe(canonicalize({ a: 1 }).text);
	});
	it("drops undefined like JSON and serializes non-finite numbers as null", () => {
		expect(canonicalize({ a: undefined, b: Number.NaN }).text).toBe('{"b":null}');
	});
	it("is bounded and deterministic for oversized input", () => {
		const big = Array.from({ length: 30_000 }, (_, i) => i);
		const one = canonicalize(big);
		expect(one.partial).toBe(true);
		expect(canonicalize(big).text).toBe(one.text);
	});
});

describe("SHA-256", () => {
	it("matches the standard test vector", async () => {
		expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
	it("fingerprints slug + data, ignoring editor keys", async () => {
		const a = await fingerprint("pricing", { title: "P", body: [{ _key: "1", t: "x" }] });
		const b = await fingerprint("pricing", { body: [{ t: "x", _key: "2" }], title: "P" });
		const c = await fingerprint("pricing-2", { title: "P", body: [{ t: "x" }] });
		expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(a.hash).toBe(b.hash);
		expect(a.hash).not.toBe(c.hash);
	});
});

describe("baseline drift", () => {
	const base = makeBaseline({ hash: "sha256:a", hosts: ["pay.example", "cdn.example"], status: "published", capturedAt: "2026-09-29T10:30:00.000Z" });
	it("reports no drift for the same state", () => {
		expect(compareToBaseline(base, { hash: "sha256:a", hosts: ["cdn.example", "pay.example"], status: "published" }).changed).toBe(false);
	});
	it("describes security-relevant differences", () => {
		const d = compareToBaseline(base, { hash: "sha256:b", hosts: ["pay2.example", "cdn.example", "x.example"], status: "draft" });
		expect(d).toMatchObject({ changed: true, hashChanged: true, domainsAdded: ["pay2.example", "x.example"], domainsRemoved: ["pay.example"], statusChanged: { from: "published", to: "draft" } });
		expect(describeDrift(d).join(" ")).toContain("2 external domain(s) introduced");
	});
});
