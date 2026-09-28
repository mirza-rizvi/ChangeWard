import { normalizeConfig, type Config } from "./config";
import { Budget } from "./budget";
import type { ChangeEvent, Incident, IncidentStatus, ResourceState } from "./types";
import { STATE_KEY, parseState, type ActivityState } from "../events/state";

/**
 * The subset of EmDash's `PluginContext` ChangeWard uses. Declared structurally so unit tests
 * can supply an in-memory host; production passes the real context.
 */
export interface Versioned<T> {
	value: T;
	revision: string;
}
type CasResult = { applied: true; revision: string } | { applied: false };

export interface HostCollection {
	get(id: string): Promise<unknown>;
	put(id: string, data: unknown): Promise<void>;
	delete(id: string): Promise<boolean>;
	getMany(ids: string[]): Promise<Map<string, unknown>>;
	putMany(items: Array<{ id: string; data: unknown }>): Promise<void>;
	deleteMany(ids: string[]): Promise<number>;
	query(options?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: unknown }>; cursor?: string; hasMore: boolean }>;
	count(where?: Record<string, unknown>): Promise<number>;
	compareAndSet(id: string, expectedRevision: string | null, data: unknown): Promise<CasResult>;
	updateIf(id: string, args: { where: Record<string, unknown>; set?: Record<string, unknown>; delta?: Record<string, { inc: number } | { dec: number }> }): Promise<{ applied: boolean }>;
}

export interface HostVersionedStore {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	getVersioned<T>(key: string): Promise<Versioned<T> | null>;
	compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<CasResult>;
}

export interface Host {
	plugin: { id: string; version: string };
	storage: Record<string, HostCollection | undefined>;
	kv: HostVersionedStore;
	settings: HostVersionedStore;
	content?: { get(collection: string, id: string): Promise<unknown> };
	redirects?: { list(options?: { limit?: number; cursor?: string }): Promise<{ items: unknown[]; cursor?: string; hasMore?: boolean }> };
	email?: { send(message: { to: string; subject: string; text: string }): Promise<void> };
	cron?: { schedule(name: string, opts: { schedule: string }): Promise<void>; cancel(name: string): Promise<void> };
	log: { warn(message: string, data?: unknown): void; error(message: string, data?: unknown): void };
	site: { url: string; name: string };
	url?(path: string): string;
}

export const CONFIG_KEY = "config";
export const COLLECTIONS = { events: "events", incidents: "incidents", resources: "resources" } as const;

export type Where = Record<string, unknown>;

export class Store {
	constructor(
		readonly host: Host,
		readonly budget: Budget = new Budget(),
	) {}

	private col(name: keyof typeof COLLECTIONS): HostCollection {
		const c = this.host.storage[COLLECTIONS[name]];
		if (!c) throw new Error(`ChangeWard storage collection "${name}" is not declared`);
		return c;
	}

	// ── config ──────────────────────────────────────────────
	async config(): Promise<Config> {
		return normalizeConfig(await this.budget.call(() => this.host.settings.get(CONFIG_KEY)));
	}

	async configVersioned(): Promise<{ config: Config; revision: string | null }> {
		const v = await this.budget.call(() => this.host.settings.getVersioned(CONFIG_KEY));
		return { config: normalizeConfig(v?.value), revision: v?.revision ?? null };
	}

	/** Compare-and-set so two administrators cannot silently overwrite each other. */
	async saveConfig(config: Config, expectedRevision: string | null): Promise<boolean> {
		const r = await this.budget.call(() => this.host.settings.compareAndSet(CONFIG_KEY, expectedRevision, config));
		return r.applied;
	}

	// ── activity state (KV) ─────────────────────────────────
	async state(): Promise<{ state: ActivityState; revision: string | null }> {
		const v = await this.budget.call(() => this.host.kv.getVersioned(STATE_KEY));
		return { state: parseState(v?.value), revision: v?.revision ?? null };
	}

	async saveState(state: ActivityState, expectedRevision: string | null): Promise<boolean> {
		const r = await this.budget.call(() => this.host.kv.compareAndSet(STATE_KEY, expectedRevision, state));
		return r.applied;
	}

	async kvGet<T>(key: string): Promise<T | null> {
		return this.budget.call(() => this.host.kv.get<T>(key));
	}

	async kvSet(key: string, value: unknown): Promise<void> {
		await this.budget.call(() => this.host.kv.set(key, value));
	}

	// ── resources ───────────────────────────────────────────
	async resource(key: string): Promise<ResourceState | null> {
		return (await this.budget.call(() => this.col("resources").get(key))) as ResourceState | null;
	}

	async putResource(r: ResourceState): Promise<void> {
		await this.budget.call(() => this.col("resources").put(r.key, r));
	}

	/**
	 * Hooks record observations without touching administrator-owned fields (protection, label,
	 * notes, baseline): an atomic partial update, or a create-only write for a new record. A
	 * deferred after-hook therefore cannot undo a protection added while it was running.
	 */
	async observeResource(full: ResourceState, fields: Partial<ResourceState>): Promise<void> {
		const updated = await this.budget.call(() => this.col("resources").updateIf(full.key, { where: {}, set: fields as Record<string, unknown> }));
		if (updated.applied || !this.budget.has(1)) return;
		await this.budget.call(() => this.col("resources").compareAndSet(full.key, null, full));
	}

	async deleteResource(key: string): Promise<void> {
		await this.budget.call(() => this.col("resources").delete(key));
	}

	async queryResources(where: Where, limit: number, cursor?: string, orderBy: Record<string, "asc" | "desc"> = { protectedAt: "desc" }) {
		return this.budget.call(() => this.col("resources").query({ where, orderBy, limit, ...(cursor ? { cursor } : {}) }));
	}

	async countResources(where: Where): Promise<number> {
		return this.budget.call(() => this.col("resources").count(where));
	}

	async deleteResources(ids: string[]): Promise<number> {
		return ids.length ? this.budget.call(() => this.col("resources").deleteMany(ids)) : 0;
	}

	// ── events ──────────────────────────────────────────────
	async putEvents(events: ChangeEvent[]): Promise<void> {
		if (events.length === 0) return;
		const [first] = events;
		if (events.length === 1 && first) await this.budget.call(() => this.col("events").put(first.id, first));
		else await this.budget.call(() => this.col("events").putMany(events.map((e) => ({ id: e.id, data: e }))));
	}

	async event(id: string): Promise<ChangeEvent | null> {
		return (await this.budget.call(() => this.col("events").get(id))) as ChangeEvent | null;
	}

	async queryEvents(where: Where, limit: number, cursor?: string) {
		return this.budget.call(() => this.col("events").query({ where, orderBy: { createdAt: "desc" }, limit, ...(cursor ? { cursor } : {}) }));
	}

	async countEvents(where: Where): Promise<number> {
		return this.budget.call(() => this.col("events").count(where));
	}

	async deleteEvents(ids: string[]): Promise<number> {
		return ids.length ? this.budget.call(() => this.col("events").deleteMany(ids)) : 0;
	}

	// ── incidents ───────────────────────────────────────────
	async incident(id: string): Promise<Incident | null> {
		return (await this.budget.call(() => this.col("incidents").get(id))) as Incident | null;
	}

	async putIncident(i: Incident): Promise<void> {
		await this.budget.call(() => this.col("incidents").put(i.id, i));
	}

	/**
	 * Merge correlation fields into an incident only while it is still open or investigating,
	 * so a hook never reopens something an administrator resolved or ignored.
	 */
	async mergeOpenIncident(i: Incident): Promise<boolean> {
		const { status: _status, statusChangedAt: _a, statusChangedBy: _b, id: _id, createdAt: _c, ...fields } = i;
		const r = await this.budget.call(() =>
			this.col("incidents").updateIf(i.id, { where: { status: { in: ["open", "investigating"] } }, set: fields }),
		);
		return r.applied;
	}

	async updateIncidentStatus(id: string, from: IncidentStatus, set: Partial<Incident>): Promise<boolean> {
		const r = await this.budget.call(() => this.col("incidents").updateIf(id, { where: { status: from }, set }));
		return r.applied;
	}

	async queryIncidents(where: Where, limit: number, cursor?: string) {
		return this.budget.call(() => this.col("incidents").query({ where, orderBy: { updatedAt: "desc" }, limit, ...(cursor ? { cursor } : {}) }));
	}

	async countIncidents(where: Where): Promise<number> {
		return this.budget.call(() => this.col("incidents").count(where));
	}

	async deleteIncidents(ids: string[]): Promise<number> {
		return ids.length ? this.budget.call(() => this.col("incidents").deleteMany(ids)) : 0;
	}
}
