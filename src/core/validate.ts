/**
 * Small validators for untrusted input (Block Kit interactions, stored config).
 * Hand-written instead of Zod to keep the sandbox bundle small.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function boundedString(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max) return undefined;
	return trimmed;
}

/** Optional free text: empty is allowed, over-long is truncated, control characters are removed. */
export function cleanText(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	// eslint-disable-next-line no-control-regex
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

export function boundedInt(value: unknown, min: number, max: number): number | undefined {
	const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) return undefined;
	return n;
}

export function bool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

/** Collection slugs and entry IDs: conservative token syntax, no separators ChangeWard uses. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

export function token(value: unknown): string | undefined {
	return typeof value === "string" && TOKEN_RE.test(value.trim()) ? value.trim() : undefined;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function email(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length <= 254 && EMAIL_RE.test(trimmed) ? trimmed : undefined;
}
