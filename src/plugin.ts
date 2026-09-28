import type { SandboxedPlugin } from "emdash/plugin";

const names = [
	"content:afterSave", "content:afterDelete", "content:beforeDelete", "content:afterPublish",
	"content:afterUnpublish", "content:afterRestore", "content:afterSchedule", "content:afterUnschedule",
	"content:beforePublish", "content:beforeSchedule", "content:beforeUnpublish", "media:afterUpload",
] as const;

const hooks: Record<string, unknown> = {};
let n = 0;
for (const name of names) {
	hooks[name] = async (event: unknown, ctx: { kv: { set(k: string, v: unknown): Promise<void> } }) => {
		n += 1;
		await ctx.kv.set(`probe:${String(Date.now()).padStart(15, "0")}:${String(n).padStart(4, "0")}:${name}`, event);
	};
}

const plugin = { hooks } as unknown as SandboxedPlugin;
export default plugin;
