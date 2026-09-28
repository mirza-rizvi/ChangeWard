import type { VolumeConfig } from "../core/config";
import type { ActionClass, ActivityState, RingEntry } from "../events/state";

const CHANGES: ReadonlySet<ActionClass> = new Set<ActionClass>(["edit", "publish", "unpublish", "schedule", "unschedule", "delete", "restore", "media"]);
const DESTRUCTIVE: ReadonlySet<ActionClass> = new Set<ActionClass>(["publish", "unpublish", "delete"]);

export interface BulkFinding {
	originKey: string;
	detail: string;
}

/**
 * Sliding-window counts per origin key (same origin and actor). Called after the new entry is in
 * the ring. Emits at most one finding per origin key per long window.
 */
export function detectBulk(state: ActivityState, entry: RingEntry, cfg: VolumeConfig, now: number): BulkFinding | undefined {
	if (!CHANGES.has(entry.a)) return undefined;
	const last = state.bulk[entry.o];
	if (last !== undefined && now - last < cfg.longWindowSec * 1000) return undefined;

	let short = 0;
	let long = 0;
	let destructive = 0;
	let protectedChanges = 0;
	const shortCut = now - cfg.shortWindowSec * 1000;
	const longCut = now - cfg.longWindowSec * 1000;
	for (const e of state.ring) {
		if (e.o !== entry.o || !CHANGES.has(e.a) || e.t < longCut) continue;
		long += 1;
		if (e.t >= shortCut) short += 1;
		if (DESTRUCTIVE.has(e.a)) destructive += 1;
		if (e.p) protectedChanges += 1;
	}

	let detail: string | undefined;
	if (protectedChanges >= cfg.protectedThreshold) detail = `${protectedChanges} protected-resource changes in ${cfg.longWindowSec / 60} min`;
	else if (destructive >= cfg.destructiveThreshold) detail = `${destructive} publish/unpublish/delete actions in ${cfg.longWindowSec / 60} min`;
	else if (short >= cfg.shortThreshold) detail = `${short} changes in ${cfg.shortWindowSec} s`;
	else if (long >= cfg.longThreshold) detail = `${long} changes in ${cfg.longWindowSec / 60} min`;
	if (!detail) return undefined;

	state.bulk[entry.o] = now;
	return { originKey: entry.o, detail };
}
