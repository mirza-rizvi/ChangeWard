import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import { handleAdmin, handlePanel } from "./admin/route";
import { defaultConfig } from "./core/config";
import { Store, type Host } from "./core/store";
import { isRecord } from "./core/validate";
import { cancelTasks, runCron, scheduleTasks } from "./cron/tasks";
import { recordMediaUpload } from "./events/observers";
import { attributionFromActor } from "./events/origin";
import { recordContentChange, type ContentChange } from "./events/recorder";
import { decidePublication, type PolicyHookEvent } from "./policies/decide";
import type { PolicyActionKind } from "./policies/engine";
import { uninstall } from "./uninstall";

function store(ctx: PluginContext): Store {
	return new Store(ctx as unknown as Host);
}

/** Observation must never break the CMS: log (without content) and swallow. */
async function observe(ctx: PluginContext, what: string, fn: (s: Store) => Promise<unknown>): Promise<void> {
	try {
		await fn(store(ctx));
	} catch (error) {
		ctx.log.warn(`ChangeWard could not record ${what}`, { error: error instanceof Error ? error.name : "unknown" });
	}
}

const OBSERVE = { priority: 900, timeout: 5000, errorPolicy: "continue" as const };

function stateChange(action: ContentChange["action"], inheritFrom?: ContentChange["inheritFrom"]) {
	return {
		...OBSERVE,
		handler: async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			const id = typeof event.content?.id === "string" ? event.content.id : undefined;
			if (!id || typeof event.collection !== "string") return;
			await observe(ctx, `a ${action}`, (s) =>
				recordContentChange(s, {
					action,
					collection: event.collection,
					resourceId: id,
					content: event.content,
					attribution: { source: "unattributed" },
					...(inheritFrom ? { inheritFrom } : {}),
				}),
			);
		},
	};
}

function policy(kind: PolicyActionKind) {
	return {
		priority: 100,
		timeout: 5000,
		// EmDash's documented default: an unexpected error stops the action with a generic failure.
		errorPolicy: "abort" as const,
		handler: async (event: PolicyHookEvent, ctx: PluginContext) => {
			const s = store(ctx);
			try {
				const decision = await decidePublication(s, kind, event);
				if (decision.result === "block" && decision.reason) return { cancel: true as const, reason: decision.reason };
				return undefined;
			} catch (error) {
				// Fail open unless the administrator chose fail-closed (read from config when possible).
				let failClosed = false;
				try {
					failClosed = s.budget.has(1) ? (await s.config()).failClosed : false;
				} catch {
					failClosed = false;
				}
				ctx.log.error("ChangeWard policy evaluation failed", { kind, failClosed, error: error instanceof Error ? error.name : "unknown" });
				if (failClosed) throw error;
				return undefined;
			}
		},
	};
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": {
			timeout: 5000,
			errorPolicy: "continue",
			handler: async (_event, ctx) => {
				const existing = await ctx.settings.getVersioned("config");
				if (!existing) await ctx.settings.compareAndSet("config", null, defaultConfig());
			},
		},
		"plugin:activate": {
			timeout: 5000,
			errorPolicy: "continue",
			handler: async (_event, ctx) => {
				await scheduleTasks(ctx as unknown as Host);
			},
		},
		"plugin:deactivate": {
			timeout: 5000,
			errorPolicy: "continue",
			handler: async (_event, ctx) => {
				await cancelTasks(ctx as unknown as Host);
			},
		},
		"plugin:uninstall": {
			timeout: 10_000,
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				if (event.deleteData) await uninstall(store(ctx));
			},
		},

		"content:afterSave": {
			...OBSERVE,
			handler: async (event, ctx) => {
				const id = typeof event.content?.id === "string" ? event.content.id : undefined;
				if (!id) return;
				await observe(ctx, "a save", (s) =>
					recordContentChange(s, {
						action: event.isNew ? "create" : "update",
						collection: event.collection,
						resourceId: id,
						content: event.content,
						attribution: attributionFromActor(event.actor),
					}),
				);
			},
		},
		"content:afterDelete": {
			...OBSERVE,
			handler: async (event, ctx) => {
				const permanent = isRecord(event) && (event as { permanent?: unknown }).permanent === true;
				await observe(ctx, "a delete", (s) =>
					recordContentChange(s, {
						action: permanent ? "delete" : "trash",
						collection: event.collection,
						resourceId: event.id,
						attribution: { source: "unattributed" },
					}),
				);
			},
		},
		"content:afterRestore": stateChange("restore"),
		"content:afterPublish": stateChange("publish", "publish"),
		"content:afterUnpublish": stateChange("unpublish", "unpublish"),
		"content:afterSchedule": stateChange("schedule", "schedule"),
		"content:afterUnschedule": stateChange("unschedule"),

		"content:beforePublish": policy("publish"),
		"content:beforeSchedule": policy("schedule"),
		"content:beforeUnpublish": policy("unpublish"),

		"media:afterUpload": {
			...OBSERVE,
			handler: async (event, ctx) => {
				await observe(ctx, "a media upload", (s) => recordMediaUpload(s, event.media));
			},
		},

		cron: {
			timeout: 25_000,
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				await observe(ctx, `cron ${event.name}`, (s) => runCron(s, event.name));
			},
		},
	},

	routes: {
		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) =>
				handleAdmin(store(ctx), {
					input: routeCtx.input,
					...(routeCtx.user?.id ? { userId: routeCtx.user.id } : {}),
					...(routeCtx.ui?.surface ? { surface: routeCtx.ui.surface } : {}),
				}),
		},
		"editor/panel": {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) =>
				handlePanel(store(ctx), {
					input: routeCtx.input,
					...(routeCtx.ui?.entry ? { entry: routeCtx.ui.entry } : {}),
					...(routeCtx.user?.id ? { userId: routeCtx.user.id } : {}),
				}),
		},
	},
};

export default plugin;
