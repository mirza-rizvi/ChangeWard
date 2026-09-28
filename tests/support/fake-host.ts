import type { Host, HostCollection, HostVersionedStore, Versioned } from "../../src/core/store";

type Row = { id: string; data: Record<string, unknown> };

function matches(value: unknown, cond: unknown): boolean {
	if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
		const c = cond as Record<string, unknown>;
		if ("in" in c) return Array.isArray(c.in) && c.in.includes(value);
		if ("startsWith" in c) return typeof value === "string" && value.startsWith(String(c.startsWith));
		const v = value as string | number;
		if (c.gt !== undefined && !(v > (c.gt as typeof v))) return false;
		if (c.gte !== undefined && !(v >= (c.gte as typeof v))) return false;
		if (c.lt !== undefined && !(v < (c.lt as typeof v))) return false;
		if (c.lte !== undefined && !(v <= (c.lte as typeof v))) return false;
		return true;
	}
	return value === cond;
}

/**
 * In-memory implementation of the storage contract documented in the EmDash plugin skill.
 * Index enforcement: a query or count may only use fields listed in `indexes`.
 */
export class FakeCollection implements HostCollection {
	rows = new Map<string, Record<string, unknown>>();
	constructor(readonly indexes: ReadonlySet<string>) {}

	private check(where: Record<string, unknown> = {}, orderBy: Record<string, unknown> = {}): void {
		for (const k of [...Object.keys(where), ...Object.keys(orderBy)]) {
			if (!this.indexes.has(k)) throw new Error(`Field "${k}" is not indexed`);
		}
	}
	async get(id: string): Promise<unknown> {
		const v = this.rows.get(id);
		return v ? structuredClone(v) : null;
	}
	async put(id: string, data: unknown) {
		this.rows.set(id, structuredClone(data) as Record<string, unknown>);
	}
	async delete(id: string) {
		return this.rows.delete(id);
	}
	async getMany(ids: string[]) {
		const m = new Map<string, unknown>();
		for (const id of ids) if (this.rows.has(id)) m.set(id, structuredClone(this.rows.get(id)));
		return m;
	}
	async putMany(items: Array<{ id: string; data: unknown }>) {
		for (const i of items) await this.put(i.id, i.data);
	}
	async deleteMany(ids: string[]) {
		let n = 0;
		for (const id of ids) if (this.rows.delete(id)) n += 1;
		return n;
	}
	private filtered(where: Record<string, unknown> = {}): Row[] {
		return [...this.rows.entries()].map(([id, data]) => ({ id, data })).filter((r) => Object.entries(where).every(([k, c]) => matches(r.data[k], c)));
	}
	async query(options: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number; cursor?: string } = {}) {
		this.check(options.where, options.orderBy);
		let rows = this.filtered(options.where);
		const [key, dir] = Object.entries(options.orderBy ?? {})[0] ?? ["", "asc"];
		if (key) {
			rows.sort((a, b) => {
				const x = a.data[key] as string;
				const y = b.data[key] as string;
				const c = x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : 1;
				return dir === "desc" ? -c : c;
			});
		}
		const limit = Math.min(options.limit ?? 50, 100);
		const start = options.cursor ? Number(options.cursor) : 0;
		rows = rows.slice(start);
		const page = rows.slice(0, limit);
		const hasMore = rows.length > limit;
		return { items: page.map((r) => ({ id: r.id, data: structuredClone(r.data) })), hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
	}
	async count(where: Record<string, unknown> = {}) {
		this.check(where);
		return this.filtered(where).length;
	}
	async compareAndSet(id: string, expected: string | null, data: unknown) {
		if (expected !== null || this.rows.has(id)) return { applied: false as const };
		await this.put(id, data);
		return { applied: true as const, revision: "1" };
	}
	async updateIf(id: string, args: { where: Record<string, unknown>; set?: Record<string, unknown>; delta?: Record<string, { inc: number } | { dec: number }> }) {
		const row = this.rows.get(id);
		if (!row || !Object.entries(args.where).every(([k, c]) => matches(row[k], c))) return { applied: false };
		Object.assign(row, structuredClone(args.set ?? {}));
		for (const [k, d] of Object.entries(args.delta ?? {})) row[k] = (Number(row[k]) || 0) + ("inc" in d ? d.inc : -d.dec);
		return { applied: true };
	}
}

export class FakeVersioned implements HostVersionedStore {
	values = new Map<string, { value: unknown; revision: string }>();
	private rev = 0;
	/** Test hook: make the next N compare-and-set calls fail as if another writer won. */
	failNextCas = 0;
	async get<T>(key: string) {
		const v = this.values.get(key);
		return v ? (structuredClone(v.value) as T) : null;
	}
	async set(key: string, value: unknown) {
		this.values.set(key, { value: structuredClone(value), revision: String(++this.rev) });
	}
	async delete(key: string) {
		return this.values.delete(key);
	}
	async getVersioned<T>(key: string): Promise<Versioned<T> | null> {
		const v = this.values.get(key);
		return v ? { value: structuredClone(v.value) as T, revision: v.revision } : null;
	}
	async compareAndSet(key: string, expected: string | null, value: unknown) {
		if (this.failNextCas > 0) {
			this.failNextCas -= 1;
			await this.set(key, (this.values.get(key)?.value as unknown) ?? null);
			return { applied: false as const };
		}
		const cur = this.values.get(key);
		if ((cur?.revision ?? null) !== expected) return { applied: false as const };
		await this.set(key, value);
		return { applied: true as const, revision: this.values.get(key)?.revision ?? "" };
	}
}

export interface FakeHost extends Host {
	storage: { events: FakeCollection; incidents: FakeCollection; resources: FakeCollection };
	kv: FakeVersioned;
	settings: FakeVersioned;
	content: { items: Map<string, unknown>; get(collection: string, id: string): Promise<unknown> };
	redirects: { rules: unknown[]; list(o?: { limit?: number; cursor?: string }): Promise<{ items: unknown[]; cursor?: string; hasMore: boolean }> };
	email: { sent: Array<{ to: string; subject: string; text: string }>; send(m: { to: string; subject: string; text: string }): Promise<void> };
	logs: string[];
}

export function fakeHost(siteUrl = "https://www.mysite.example"): FakeHost {
	const logs: string[] = [];
	const content = {
		items: new Map<string, unknown>(),
		async get(collection: string, id: string) {
			const v = content.items.get(`${collection}:${id}`);
			return v ? structuredClone(v) : null;
		},
	};
	const redirects = {
		rules: [] as unknown[],
		async list(o: { limit?: number; cursor?: string } = {}) {
			const start = o.cursor ? Number(o.cursor) : 0;
			const limit = o.limit ?? 50;
			const items = redirects.rules.slice(start, start + limit);
			const hasMore = start + limit < redirects.rules.length;
			return { items, hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
		},
	};
	const email = {
		sent: [] as Array<{ to: string; subject: string; text: string }>,
		async send(m: { to: string; subject: string; text: string }) {
			email.sent.push(m);
		},
	};
	return {
		plugin: { id: "changeward", version: "0.1.0" },
		storage: {
			events: new FakeCollection(new Set(["createdAt", "originSource", "category", "action", "severity", "protectedResource", "resourceKey", "incidentId"])),
			incidents: new FakeCollection(new Set(["updatedAt", "status"])),
			resources: new FakeCollection(new Set(["lastSeenAt", "isProtected", "protectedAt"])),
		},
		kv: new FakeVersioned(),
		settings: new FakeVersioned(),
		content,
		redirects,
		email,
		cron: { async schedule() {}, async cancel() {} },
		log: { warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
		logs,
		site: { url: siteUrl, name: "My Site" },
		url: (p: string) => `${siteUrl}${p}`,
	};
}
