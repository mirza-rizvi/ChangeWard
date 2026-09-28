import { LIMITS } from "../core/limits";
import type { Host, Store } from "../core/store";
import type { ResourceState } from "../core/types";
import { commitState } from "../events/pipeline";
import { scanRedirects } from "../events/observers";
import type { PendingAlert } from "../events/state";

export const CRON_TASKS = {
	cleanup: { name: "changeward-cleanup", schedule: "17 * * * *" },
	redirects: { name: "changeward-redirects", schedule: "*/15 * * * *" },
	alerts: { name: "changeward-alerts", schedule: "*/5 * * * *" },
} as const;

export async function scheduleTasks(host: Host): Promise<void> {
	if (!host.cron) return;
	for (const task of Object.values(CRON_TASKS)) await host.cron.schedule(task.name, { schedule: task.schedule });
}

export async function cancelTasks(host: Host): Promise<void> {
	if (!host.cron) return;
	for (const task of Object.values(CRON_TASKS)) await host.cron.cancel(task.name);
}

const DAY = 86_400_000;

/**
 * Retention. Deletes expired events, closed incidents past incident retention, and unprotected
 * resource records not seen within event retention. Bounded per run; the hourly schedule catches up.
 * Budget: config 1, events 2×2, incidents 2, resources 2 → 9.
 */
export async function runCleanup(store: Store, now = Date.now()): Promise<{ events: number; incidents: number; resources: number }> {
	const config = await store.config();
	const eventCutoff = new Date(now - config.retentionDays * DAY).toISOString();
	const incidentCutoff = new Date(now - config.incidentRetentionDays * DAY).toISOString();
	let events = 0;
	for (let i = 0; i < LIMITS.cleanupBatches && store.budget.has(6); i += 1) {
		const page = await store.queryEvents({ createdAt: { lt: eventCutoff } }, 100);
		events += await store.deleteEvents(page.items.map((x) => x.id));
		if (!page.hasMore) break;
	}
	let incidents = 0;
	if (store.budget.has(4)) {
		const page = await store.queryIncidents({ status: { in: ["resolved", "ignored"] }, updatedAt: { lt: incidentCutoff } }, 100);
		incidents = await store.deleteIncidents(page.items.map((x) => x.id));
	}
	let resources = 0;
	if (store.budget.has(2)) {
		const page = await store.queryResources({ lastSeenAt: { lt: eventCutoff } }, 100, undefined, { lastSeenAt: "asc" });
		const stale = page.items.filter((x) => (x.data as ResourceState).isProtected !== true).map((x) => x.id);
		resources = await store.deleteResources(stale);
	}
	return { events, incidents, resources };
}

/**
 * Alert delivery: one digest email per run for incidents that crossed the alert threshold.
 * The pending list is cleared before sending (at-most-once) so a failing transport cannot cause
 * repeated mail. Budget: config 1, state 2 (+2), email 1.
 */
export async function runAlerts(store: Store, now = Date.now()): Promise<number> {
	const config = await store.config();
	const { alerts } = config;
	if (!alerts.enabled || !alerts.email || !store.host.email) return 0;
	const email = store.host.email;
	const taken = await commitState(store, (state): { batch: PendingAlert[]; stateLost?: boolean } => {
		const pending = state.alerts.pending;
		if (pending.length === 0) return { batch: [] as PendingAlert[] };
		if (state.alerts.lastSentAt && now - state.alerts.lastSentAt < alerts.cooldownMin * 60_000) return { batch: [] as PendingAlert[] };
		const batch = pending.slice(0, 10);
		state.alerts.pending = pending.slice(10);
		state.alerts.lastSentAt = now;
		return { batch };
	});
	if (taken.stateLost || taken.batch.length === 0) return 0;
	const lines = taken.batch.map((a) => `- ${a.incidentId} [${a.severity.toUpperCase()}] ${a.title}`);
	const link = store.host.url ? store.host.url(`/_emdash/admin/plugins/${store.host.plugin.id}/incidents`) : "";
	await store.budget.call(() =>
		email.send({
			to: alerts.email,
			subject: `[ChangeWard] ${taken.batch.length} incident(s) need review on ${store.host.site.name || "your site"}`,
			text: [
				"ChangeWard grouped recent CMS changes into incidents that meet your alert threshold.",
				"Review recommended. ChangeWard describes what changed and how; it does not determine intent.",
				"",
				...lines,
				"",
				link ? `Open ChangeWard: ${link}` : "Open ChangeWard from the EmDash admin.",
				"",
				"You receive this because ChangeWard email alerts are enabled in ChangeWard → Settings.",
			].join("\n"),
		}),
	);
	return taken.batch.length;
}

export async function runCron(store: Store, name: string): Promise<void> {
	if (name === CRON_TASKS.cleanup.name) await runCleanup(store);
	else if (name === CRON_TASKS.redirects.name) await scanRedirects(store);
	else if (name === CRON_TASKS.alerts.name) await runAlerts(store);
}

