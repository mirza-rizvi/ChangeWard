import { LIMITS } from "../core/limits";

/**
 * Deterministic JSON canonical form for integrity fingerprints.
 *
 * - object keys sorted by UTF-16 code unit order;
 * - Portable Text `_key` values dropped (editor-generated identifiers, not content);
 * - strings NFC-normalized with CRLF/CR folded to LF;
 * - `undefined`, functions and symbols dropped, like JSON;
 * - non-finite numbers serialized as `null`, like JSON.
 *
 * The walk is bounded by `LIMITS.canonicalNodes`; beyond it the remaining subtree is replaced by
 * a fixed marker so the output stays deterministic and the result is flagged partial.
 */
export interface Canonical {
	text: string;
	partial: boolean;
}

export function canonicalize(value: unknown): Canonical {
	let nodes = 0;
	let partial = false;

	const enc = (v: unknown): string | undefined => {
		nodes += 1;
		if (nodes > LIMITS.canonicalNodes) {
			partial = true;
			return '"[changeward:truncated]"';
		}
		if (v === null) return "null";
		switch (typeof v) {
			case "string":
				return JSON.stringify(v.normalize("NFC").replace(/\r\n?/g, "\n"));
			case "number":
				return Number.isFinite(v) ? JSON.stringify(v) : "null";
			case "boolean":
				return v ? "true" : "false";
			case "object": {
				if (Array.isArray(v)) return `[${v.map((item) => enc(item) ?? "null").join(",")}]`;
				const record = v as Record<string, unknown>;
				const parts: string[] = [];
				for (const key of Object.keys(record).sort()) {
					if (key === "_key") continue;
					const encoded = enc(record[key]);
					if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
				}
				return `{${parts.join(",")}}`;
			}
			default:
				return undefined;
		}
	};

	return { text: enc(value) ?? "null", partial };
}

/** The security-relevant state of an entry: slug and field data. Timestamps and revision IDs are excluded. */
export function fingerprintInput(slug: unknown, data: unknown): unknown {
	return { slug: typeof slug === "string" ? slug : null, data: data ?? null };
}
