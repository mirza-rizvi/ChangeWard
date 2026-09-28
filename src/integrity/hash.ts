import { canonicalize, fingerprintInput } from "./canonicalize";

/** SHA-256 via Web Crypto, lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	const bytes = new Uint8Array(digest);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

export interface Fingerprint {
	hash: string;
	partial: boolean;
}

export async function fingerprint(slug: unknown, data: unknown): Promise<Fingerprint> {
	const canonical = canonicalize(fingerprintInput(slug, data));
	return { hash: `sha256:${await sha256Hex(canonical.text)}`, partial: canonical.partial };
}

export function shortHash(hash: string | undefined): string {
	if (!hash) return "—";
	const hex = hash.startsWith("sha256:") ? hash.slice(7) : hash;
	return hex.slice(0, 12);
}
