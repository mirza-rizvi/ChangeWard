import { normalizeDomainEntry } from "../intelligence/domains";
import { LIMITS } from "./limits";
import { POLICY_ACTIONS, SEVERITIES, type PolicyAction, type Severity } from "./types";
import { bool, boundedInt, email, isRecord, oneOf } from "./validate";

export const POLICY_RULES = [
	"blocked-domain",
	"dangerous-scheme",
	"protected-unknown-domain",
	"protected-origin-mcp",
	"protected-origin-api",
	"protected-origin-plugin",
	"protected-insecure-http",
	"protected-embed",
	"protected-unpublish",
] as const;
export type PolicyRuleId = (typeof POLICY_RULES)[number];

export const RETENTION_DAYS = [7, 30, 90, 180] as const;
export const INCIDENT_RETENTION_DAYS = [30, 90, 180, 365] as const;

export interface VolumeConfig {
	shortWindowSec: number;
	shortThreshold: number;
	longWindowSec: number;
	longThreshold: number;
	/** Publishes, unpublishes and deletes by one origin within the long window. */
	destructiveThreshold: number;
	/** Changes to protected resources by one origin within the long window. */
	protectedThreshold: number;
}

export interface AlertConfig {
	enabled: boolean;
	email: string;
	minSeverity: Severity;
	cooldownMin: number;
}

export interface Config {
	version: 1;
	/** `monitor` downgrades every BLOCK to WARN without changing the configured rules. */
	mode: "enforce" | "monitor";
	/** Rethrow internal errors in policy hooks so EmDash's abort semantics stop the publication. */
	failClosed: boolean;
	rules: Record<PolicyRuleId, PolicyAction>;
	trustedDomains: string[];
	blockedDomains: string[];
	retentionDays: number;
	incidentRetentionDays: number;
	volume: VolumeConfig;
	correlationWindowMin: number;
	alerts: AlertConfig;
	redirectMonitoring: boolean;
	mediaMonitoring: boolean;
}

export const DEFAULT_RULES: Record<PolicyRuleId, PolicyAction> = {
	"blocked-domain": "block",
	"dangerous-scheme": "block",
	"protected-unknown-domain": "warn",
	"protected-origin-mcp": "warn",
	"protected-origin-api": "allow",
	"protected-origin-plugin": "allow",
	"protected-insecure-http": "warn",
	"protected-embed": "warn",
	"protected-unpublish": "warn",
};

export const DEFAULT_VOLUME: VolumeConfig = {
	shortWindowSec: 60,
	shortThreshold: 20,
	longWindowSec: 300,
	longThreshold: 60,
	destructiveThreshold: 15,
	protectedThreshold: 8,
};

export function defaultConfig(): Config {
	return {
		version: 1,
		mode: "enforce",
		failClosed: false,
		rules: { ...DEFAULT_RULES },
		trustedDomains: [],
		blockedDomains: [],
		retentionDays: 30,
		incidentRetentionDays: 180,
		volume: { ...DEFAULT_VOLUME },
		correlationWindowMin: 10,
		alerts: { enabled: false, email: "", minSeverity: "high", cooldownMin: 30 },
		redirectMonitoring: true,
		mediaMonitoring: true,
	};
}

export function normalizeDomainList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
	const out: string[] = [];
	for (const entry of raw) {
		const normalized = normalizeDomainEntry(entry);
		if (normalized && !out.includes(normalized)) out.push(normalized);
		if (out.length >= LIMITS.domainListEntries) break;
	}
	return out;
}

function pickNumber<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
	const n = boundedInt(value, 0, 100_000);
	return n !== undefined && (allowed as readonly number[]).includes(n) ? (n as T) : fallback;
}

/** Tolerant read of a stored config: unknown or invalid fields fall back to defaults. */
export function normalizeConfig(raw: unknown): Config {
	const base = defaultConfig();
	if (!isRecord(raw)) return base;
	const rules = { ...base.rules };
	if (isRecord(raw.rules)) {
		for (const id of POLICY_RULES) rules[id] = oneOf(raw.rules[id], POLICY_ACTIONS) ?? rules[id];
	}
	const v = isRecord(raw.volume) ? raw.volume : {};
	const a = isRecord(raw.alerts) ? raw.alerts : {};
	return {
		version: 1,
		mode: oneOf(raw.mode, ["enforce", "monitor"] as const) ?? base.mode,
		failClosed: bool(raw.failClosed) ?? base.failClosed,
		rules,
		trustedDomains: normalizeDomainList(raw.trustedDomains),
		blockedDomains: normalizeDomainList(raw.blockedDomains),
		retentionDays: pickNumber(raw.retentionDays, RETENTION_DAYS, 30),
		incidentRetentionDays: pickNumber(raw.incidentRetentionDays, INCIDENT_RETENTION_DAYS, 180),
		volume: {
			shortWindowSec: boundedInt(v.shortWindowSec, 10, 600) ?? base.volume.shortWindowSec,
			shortThreshold: boundedInt(v.shortThreshold, 2, 1000) ?? base.volume.shortThreshold,
			longWindowSec: boundedInt(v.longWindowSec, 60, 900) ?? base.volume.longWindowSec,
			longThreshold: boundedInt(v.longThreshold, 2, 5000) ?? base.volume.longThreshold,
			destructiveThreshold: boundedInt(v.destructiveThreshold, 2, 1000) ?? base.volume.destructiveThreshold,
			protectedThreshold: boundedInt(v.protectedThreshold, 2, 1000) ?? base.volume.protectedThreshold,
		},
		correlationWindowMin: boundedInt(raw.correlationWindowMin, 1, 15) ?? base.correlationWindowMin,
		alerts: {
			enabled: bool(a.enabled) ?? base.alerts.enabled,
			email: email(a.email) ?? "",
			minSeverity: oneOf(a.minSeverity, SEVERITIES) ?? base.alerts.minSeverity,
			cooldownMin: boundedInt(a.cooldownMin, 5, 1440) ?? base.alerts.cooldownMin,
		},
		redirectMonitoring: bool(raw.redirectMonitoring) ?? base.redirectMonitoring,
		mediaMonitoring: bool(raw.mediaMonitoring) ?? base.mediaMonitoring,
	};
}
