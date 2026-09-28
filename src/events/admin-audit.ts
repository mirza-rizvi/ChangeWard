import type { Config } from "../core/config";
import type { Store } from "../core/store";
import type { ChangeEvent, Severity } from "../core/types";
import { newEventId } from "./pipeline";

/**
 * ChangeWard's own governance changes (protection, baselines, policies, settings) are part of the
 * audit trail: loosening a rule or unprotecting a page is exactly the change an administrator
 * reviewing an incident needs to see. One bridge call; no correlation.
 */
export async function recordAdminAction(
	store: Store,
	input: { action: string; summary: string; userId?: string; severity?: Severity; collection?: string; resourceId?: string; resourceTitle?: string; protectedResource?: boolean },
	now = Date.now(),
): Promise<void> {
	if (!store.budget.has(1)) return;
	const e: ChangeEvent = {
		id: newEventId(now),
		createdAt: new Date(now).toISOString(),
		category: "system",
		action: input.action,
		severity: input.severity ?? "info",
		summary: input.summary.slice(0, 200),
		originSource: "system",
		protectedResource: input.protectedResource ?? false,
		...(input.userId ? { actorId: input.userId } : {}),
		...(input.collection ? { collection: input.collection } : {}),
		...(input.resourceId ? { resourceId: input.resourceId } : {}),
		...(input.collection && input.resourceId ? { resourceKey: `${input.collection}:${input.resourceId}` } : {}),
		...(input.resourceTitle ? { resourceTitle: input.resourceTitle.slice(0, 120) } : {}),
	};
	try {
		await store.putEvents([e]);
	} catch {
		// Auditing must not turn a successful administrator action into an error.
	}
}

/** Human-readable list of what changed between two configs, most important first. */
export function describeConfigChange(before: Config, after: Config): { text: string; loosened: boolean } {
	const parts: string[] = [];
	let loosened = false;
	const rank = { allow: 0, warn: 1, block: 2 } as const;
	if (before.mode !== after.mode) {
		parts.push(`mode ${before.mode} → ${after.mode}`);
		if (after.mode === "monitor") loosened = true;
	}
	for (const rule of Object.keys(after.rules) as Array<keyof Config["rules"]>) {
		if (before.rules[rule] !== after.rules[rule]) {
			parts.push(`${rule} ${before.rules[rule]} → ${after.rules[rule]}`);
			if (rank[after.rules[rule]] < rank[before.rules[rule]]) loosened = true;
		}
	}
	const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
	const trustedAdded = added(before.trustedDomains, after.trustedDomains);
	const blockedRemoved = added(after.blockedDomains, before.blockedDomains);
	if (trustedAdded.length) parts.push(`trusted +${trustedAdded.slice(0, 3).join(", ")}`);
	if (added(after.trustedDomains, before.trustedDomains).length) parts.push("trusted domains removed");
	if (added(before.blockedDomains, after.blockedDomains).length) parts.push(`blocked +${added(before.blockedDomains, after.blockedDomains).slice(0, 3).join(", ")}`);
	if (blockedRemoved.length) parts.push(`blocked −${blockedRemoved.slice(0, 3).join(", ")}`);
	if (trustedAdded.length || blockedRemoved.length) loosened = true;
	if (before.failClosed !== after.failClosed) parts.push(`fail closed ${after.failClosed ? "on" : "off"}`);
	if (before.retentionDays !== after.retentionDays) parts.push(`retention ${before.retentionDays} → ${after.retentionDays} days`);
	if (before.alerts.enabled !== after.alerts.enabled) parts.push(`email alerts ${after.alerts.enabled ? "on" : "off"}`);
	if (before.alerts.email !== after.alerts.email) parts.push("alert recipient changed");
	if (JSON.stringify(before.volume) !== JSON.stringify(after.volume)) parts.push("volume thresholds changed");
	if (before.correlationWindowMin !== after.correlationWindowMin) parts.push(`correlation window ${after.correlationWindowMin} min`);
	if (before.redirectMonitoring !== after.redirectMonitoring) parts.push(`redirect checks ${after.redirectMonitoring ? "on" : "off"}`);
	if (before.mediaMonitoring !== after.mediaMonitoring) parts.push(`media recording ${after.mediaMonitoring ? "on" : "off"}`);
	return { text: parts.length ? parts.join("; ") : "no effective change", loosened };
}
