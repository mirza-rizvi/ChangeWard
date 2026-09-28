import {
	INCIDENT_RETENTION_DAYS,
	POLICY_RULES,
	RETENTION_DAYS,
	normalizeDomainList,
	type Config,
	type PolicyRuleId,
} from "../core/config";
import { LIMITS } from "../core/limits";
import type { Store } from "../core/store";
import { POLICY_ACTIONS, SEVERITIES } from "../core/types";
import { bool, boundedInt, email, oneOf } from "../core/validate";
import { normalizeDomainEntry } from "../intelligence/domains";
import { commitState } from "../events/pipeline";
import { describeConfigChange, recordAdminAction } from "../events/admin-audit";
import { page, type Block, type BlockResponse } from "./ui";

export const RULE_TEXT: Record<PolicyRuleId, string> = {
	"blocked-domain": "Content contains a domain on the blocked list",
	"dangerous-scheme": "Publication introduces a javascript:, vbscript: or data: URL in a link, frame or script",
	"protected-unknown-domain": "Protected resource introduces a domain that is not trusted",
	"protected-origin-mcp": "Protected resource is published, scheduled or unpublished via MCP",
	"protected-origin-api": "Protected resource is published, scheduled or unpublished via the API",
	"protected-origin-plugin": "Protected resource is published, scheduled or unpublished by a plugin",
	"protected-insecure-http": "Protected resource introduces an external http:// link",
	"protected-embed": "Protected resource introduces a script, iframe, embedded object or form target",
	"protected-unpublish": "Protected resource is unpublished",
};

const ACTION_OPTIONS = POLICY_ACTIONS.map((a) => ({ label: a.toUpperCase(), value: a }));

/** The config revision travels in the form's block_id and is used only as a staleness token. */
function revToken(prefix: string, revision: string | null): string {
	return `${prefix}:${revision ? `r:${revision}` : "new"}`;
}

export function revFromBlockId(prefix: string, blockId: string | undefined): string | null | undefined {
	if (!blockId?.startsWith(`${prefix}:`)) return undefined;
	const rest = blockId.slice(prefix.length + 1);
	if (rest === "new") return null;
	return rest.startsWith("r:") && rest.length <= 200 ? rest.slice(2) : undefined;
}

/** Budget: config 1, state 1. */
export async function policiesPage(store: Store, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
	const { config, revision } = await store.configVersioned();
	const { state } = await store.state();
	const observed = Object.entries(state.observed)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 25);
	const blocks: Block[] = [
		{
			type: "section",
			text: "Policies are checked when content is published, scheduled or unpublished, whichever origin asks. Saving drafts is never blocked. WARN allows the action and records it here; BLOCK rejects it with an explanation.",
		},
		...(config.mode === "monitor"
			? [{ type: "banner" as const, variant: "alert" as const, title: "Monitor mode", description: "Every BLOCK is recorded as WARN. Nothing is rejected." }]
			: []),
		{
			type: "form",
			block_id: revToken("policies", revision),
			fields: [
				{
					type: "select",
					action_id: "mode",
					label: "Enforcement",
					options: [
						{ label: "Enforce (BLOCK rejects the action)", value: "enforce" },
						{ label: "Monitor only (BLOCK is recorded as WARN)", value: "monitor" },
					],
					initial_value: config.mode,
				},
				...POLICY_RULES.map((rule) => ({
					type: "select" as const,
					action_id: `rule_${rule}`,
					label: `${rule}: ${RULE_TEXT[rule]}`,
					options: ACTION_OPTIONS,
					initial_value: config.rules[rule],
				})),
				{ type: "text_input", action_id: "trusted", label: "Trusted domains (one per line; subdomains included)", multiline: true, initial_value: config.trustedDomains.join("\n") },
				{ type: "text_input", action_id: "blocked", label: "Blocked domains (one per line; subdomains included)", multiline: true, initial_value: config.blockedDomains.join("\n") },
				{
					type: "toggle",
					action_id: "failClosed",
					label: "Fail closed",
					description: "If ChangeWard cannot evaluate a policy because of an internal error, let EmDash stop the publication (generic error) instead of allowing it.",
					initial_value: config.failClosed,
				},
			],
			submit: { label: "Save policies", action_id: "policies:save" },
		},
		{ type: "header", text: "Recently observed domains" },
		{ type: "context", text: "External domains ChangeWard has seen in content. New does not mean malicious; mark domains you expect as trusted to quiet the log." },
		{
			type: "table",
			block_id: "policies:observed",
			columns: [
				{ key: "host", label: "Domain", format: "code" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "seen", label: "Last seen", format: "relative_time" },
				{ key: "actions", label: "", format: "element" },
			],
			rows: observed.map(([host, t]) => ({
				host,
				status: config.blockedDomains.some((d) => host === d || host.endsWith(`.${d}`)) ? "Blocked" : config.trustedDomains.some((d) => host === d || host.endsWith(`.${d}`)) ? "Trusted" : "Observed",
				seen: new Date(t).toISOString(),
				actions: {
					type: "menu",
					action_id: "policies:domain",
					label: "Classify",
					items: [
						{ label: "Trust", value: `trust|${host}` },
						{ label: "Block", value: `block|${host}` },
					],
				},
			})),
			page_action_id: "policies:noop",
			empty_text: "No external domains observed yet.",
		},
	];
	return page("/policies", "Policies", blocks, toast);
}

const STALE: BlockResponse["toast"] = { type: "error", message: "Settings were changed by someone else. Your changes were not saved; the page shows the current values." };

/** Budget: config 1, CAS 1, page 2. */
async function audit(store: Store, before: Config, after: Config, userId: string | undefined): Promise<void> {
	const change = describeConfigChange(before, after);
	if (change.text === "no effective change") return;
	await recordAdminAction(store, {
		action: "config.updated",
		summary: `ChangeWard configuration changed: ${change.text}`,
		severity: change.loosened ? "low" : "info",
		...(userId ? { userId } : {}),
	});
}

export async function savePolicies(store: Store, values: Record<string, unknown>, blockId: string | undefined, userId?: string): Promise<BlockResponse> {
	const expected = revFromBlockId("policies", blockId);
	if (expected === undefined) return policiesPage(store, { type: "error", message: "Invalid form." });
	const { config } = await store.configVersioned();
	const next: Config = { ...config, rules: { ...config.rules } };
	next.mode = oneOf(values.mode, ["enforce", "monitor"] as const) ?? config.mode;
	next.failClosed = bool(values.failClosed) ?? config.failClosed;
	for (const rule of POLICY_RULES) next.rules[rule] = oneOf(values[`rule_${rule}`], POLICY_ACTIONS) ?? config.rules[rule];
	const invalid: string[] = [];
	for (const [field, key] of [["trusted", "trustedDomains"], ["blocked", "blockedDomains"]] as const) {
		const raw = typeof values[field] === "string" ? (values[field] as string) : "";
		const entries = raw.split(/[\s,]+/).filter(Boolean);
		for (const e of entries) if (!normalizeDomainEntry(e)) invalid.push(e.slice(0, 60));
		next[key] = normalizeDomainList(entries);
	}
	if (invalid.length) return policiesPage(store, { type: "error", message: `Not a valid domain: ${invalid.slice(0, 3).join(", ")}. Nothing was saved.` });
	for (const field of ["trusted", "blocked"] as const) {
		const raw = typeof values[field] === "string" ? (values[field] as string) : "";
		if (new Set(raw.split(/[\s,]+/).filter(Boolean).map((e) => normalizeDomainEntry(e))).size > LIMITS.domainListEntries) {
			return policiesPage(store, { type: "error", message: `Each domain list holds at most ${LIMITS.domainListEntries} entries. Nothing was saved.` });
		}
	}
	if (!(await store.saveConfig(next, expected))) return policiesPage(store, STALE);
	await audit(store, config, next, userId);
	return policiesPage(store, { type: "success", message: "Policies saved." });
}

/** Budget: config 1, CAS 1, page 2. */
export async function classifyDomain(store: Store, op: string, hostRaw: string, userId?: string): Promise<BlockResponse> {
	const host = normalizeDomainEntry(hostRaw);
	if (!host || (op !== "trust" && op !== "block")) return policiesPage(store, { type: "error", message: "Invalid domain." });
	const { config, revision } = await store.configVersioned();
	const add = op === "trust" ? "trustedDomains" : "blockedDomains";
	if (!config[add].includes(host) && config[add].length >= LIMITS.domainListEntries) {
		return policiesPage(store, { type: "error", message: `The ${op === "trust" ? "trusted" : "blocked"} list is full (${LIMITS.domainListEntries} entries). Remove an entry first.` });
	}
	const remove = op === "trust" ? "blockedDomains" : "trustedDomains";
	const next: Config = { ...config, [add]: normalizeDomainList([...config[add], host]), [remove]: config[remove].filter((d) => d !== host) };
	if (!(await store.saveConfig(next, revision))) return policiesPage(store, STALE);
	await audit(store, config, next, userId);
	return policiesPage(store, { type: "success", message: `${host} marked ${op === "trust" ? "trusted" : "blocked"}.` });
}

/** Budget: config 1. */
export async function settingsPage(store: Store, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
	const { config, revision } = await store.configVersioned();
	const emailAvailable = store.host.email !== undefined;
	const blocks: Block[] = [
		...(!emailAvailable && config.alerts.enabled
			? [{ type: "banner" as const, variant: "alert" as const, title: "Email is not configured", description: "EmDash has no email provider, so alerts are queued but not delivered." }]
			: []),
		{
			type: "form",
			block_id: revToken("settings", revision),
			fields: [
				{ type: "select", action_id: "retentionDays", label: "Keep activity for", options: RETENTION_DAYS.map((d) => ({ label: `${d} days`, value: String(d) })), initial_value: String(config.retentionDays) },
				{
					type: "select",
					action_id: "incidentRetentionDays",
					label: "Keep resolved and ignored incident summaries for",
					options: INCIDENT_RETENTION_DAYS.map((d) => ({ label: `${d} days`, value: String(d) })),
					initial_value: String(config.incidentRetentionDays),
				},
				{ type: "number_input", action_id: "correlationWindowMin", label: "Correlation window (minutes)", min: 1, max: 15, initial_value: config.correlationWindowMin },
				{ type: "number_input", action_id: "shortThreshold", label: `Unusual volume: changes by one origin and actor within ${config.volume.shortWindowSec} s`, min: 2, max: 1000, initial_value: config.volume.shortThreshold },
				{ type: "number_input", action_id: "longThreshold", label: `Unusual volume: changes by one origin and actor within ${config.volume.longWindowSec / 60} min`, min: 2, max: 5000, initial_value: config.volume.longThreshold },
				{ type: "number_input", action_id: "destructiveThreshold", label: `Unusual volume: publish, unpublish and delete actions within ${config.volume.longWindowSec / 60} min`, min: 2, max: 1000, initial_value: config.volume.destructiveThreshold },
				{ type: "number_input", action_id: "protectedThreshold", label: `Unusual volume: protected-resource changes within ${config.volume.longWindowSec / 60} min`, min: 2, max: 1000, initial_value: config.volume.protectedThreshold },
				{ type: "toggle", action_id: "redirectMonitoring", label: "Check redirects every 15 minutes", initial_value: config.redirectMonitoring },
				{ type: "toggle", action_id: "mediaMonitoring", label: "Record media uploads", initial_value: config.mediaMonitoring },
				{ type: "toggle", action_id: "alertsEnabled", label: "Email alerts", description: "Sent through EmDash's configured email provider as a digest, at most once per cooldown.", initial_value: config.alerts.enabled },
				{ type: "text_input", action_id: "alertEmail", label: "Alert recipient", initial_value: config.alerts.email, condition: { field: "alertsEnabled", eq: true } },
				{
					type: "select",
					action_id: "alertMinSeverity",
					label: "Alert when an incident reaches",
					options: SEVERITIES.filter((s) => s !== "info").map((s) => ({ label: s, value: s })),
					initial_value: config.alerts.minSeverity,
					condition: { field: "alertsEnabled", eq: true },
				},
				{ type: "number_input", action_id: "alertCooldown", label: "Minimum minutes between alert emails", min: 5, max: 1440, initial_value: config.alerts.cooldownMin, condition: { field: "alertsEnabled", eq: true } },
			],
			submit: { label: "Save settings", action_id: "settings:save" },
		},
		{ type: "context", text: "ChangeWard stores change summaries, hashes and domain names, not content bodies, and sends nothing outside your EmDash site except the alert emails you enable here." },
	];
	return page("/settings", "Settings", blocks, toast);
}

/** Budget: config 1, CAS 1, state 2 (only when the window changes), page 1. */
export async function saveSettings(store: Store, values: Record<string, unknown>, blockId: string | undefined, userId?: string): Promise<BlockResponse> {
	const expected = revFromBlockId("settings", blockId);
	if (expected === undefined) return settingsPage(store, { type: "error", message: "Invalid form." });
	const { config } = await store.configVersioned();
	const errors: string[] = [];
	const num = (key: string, min: number, max: number, fallback: number): number => {
		if (values[key] === undefined || values[key] === "") return fallback;
		const n = boundedInt(values[key], min, max);
		if (n === undefined) errors.push(`${key} must be a whole number from ${min} to ${max}`);
		return n ?? fallback;
	};
	const retention = boundedInt(values.retentionDays, 1, 10_000);
	const incidentRetention = boundedInt(values.incidentRetentionDays, 1, 10_000);
	const alertsEnabled = bool(values.alertsEnabled) ?? config.alerts.enabled;
	const rawEmail = typeof values.alertEmail === "string" ? values.alertEmail.trim() : config.alerts.email;
	const alertEmail = rawEmail === "" ? "" : email(rawEmail);
	if (alertEmail === undefined) errors.push("Alert recipient is not a valid email address");
	if (alertsEnabled && !alertEmail) errors.push("Enter an alert recipient or turn email alerts off");
	const next: Config = {
		...config,
		retentionDays: retention !== undefined && (RETENTION_DAYS as readonly number[]).includes(retention) ? retention : config.retentionDays,
		incidentRetentionDays: incidentRetention !== undefined && (INCIDENT_RETENTION_DAYS as readonly number[]).includes(incidentRetention) ? incidentRetention : config.incidentRetentionDays,
		correlationWindowMin: num("correlationWindowMin", 1, 15, config.correlationWindowMin),
		volume: {
			...config.volume,
			shortThreshold: num("shortThreshold", 2, 1000, config.volume.shortThreshold),
			longThreshold: num("longThreshold", 2, 5000, config.volume.longThreshold),
			destructiveThreshold: num("destructiveThreshold", 2, 1000, config.volume.destructiveThreshold),
			protectedThreshold: num("protectedThreshold", 2, 1000, config.volume.protectedThreshold),
		},
		redirectMonitoring: bool(values.redirectMonitoring) ?? config.redirectMonitoring,
		mediaMonitoring: bool(values.mediaMonitoring) ?? config.mediaMonitoring,
		alerts: {
			enabled: alertsEnabled,
			email: alertEmail ?? config.alerts.email,
			minSeverity: oneOf(values.alertMinSeverity, SEVERITIES) ?? config.alerts.minSeverity,
			cooldownMin: num("alertCooldown", 5, 1440, config.alerts.cooldownMin),
		},
	};
	if (errors.length) return settingsPage(store, { type: "error", message: `${errors.slice(0, 2).join(". ")}. Nothing was saved.` });
	if (!(await store.saveConfig(next, expected))) return settingsPage(store, STALE);
	await audit(store, config, next, userId);
	if (!next.alerts.enabled && config.alerts.enabled) {
		// Drop queued alerts so re-enabling later does not send stale mail.
		await commitState(store, (state) => {
			state.alerts.pending = [];
			return {};
		}, false);
	}
	return settingsPage(store, { type: "success", message: "Settings saved." });
}
