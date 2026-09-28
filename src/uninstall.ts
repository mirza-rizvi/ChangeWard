import type { Store } from "./core/store";
import { STATE_KEY } from "./events/state";
import { REDIRECT_SNAPSHOT_KEY } from "./events/observers";

/**
 * Best-effort data removal when an administrator uninstalls with "delete data".
 * One invocation can make only a few bridge calls, so large histories may need EmDash's own
 * plugin-storage cleanup; see docs/PRIVACY.md.
 */
export async function uninstall(store: Store): Promise<void> {
	await store.budget.call(() => store.host.kv.delete(STATE_KEY));
	await store.budget.call(() => store.host.kv.delete(REDIRECT_SNAPSHOT_KEY));
	await store.budget.call(() => store.host.settings.delete("config"));
	const events = await store.queryEvents({}, 100);
	await store.deleteEvents(events.items.map((x) => x.id));
	const incidents = await store.queryIncidents({}, 100);
	await store.deleteIncidents(incidents.items.map((x) => x.id));
	const resources = await store.queryResources({}, 100, undefined, { lastSeenAt: "asc" });
	await store.deleteResources(resources.items.map((x) => x.id));
}
