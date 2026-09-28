import type { Config, PolicyRuleId } from "../core/config";
import type { Attribution, PolicyAction, PolicyOutcome, SignalCode } from "../core/types";
import { matchesAny } from "../intelligence/domains";
import type { Analysis } from "../intelligence/classify-change";
import { viaPhrase } from "../events/origin";

export type PolicyActionKind = "publish" | "schedule" | "unpublish";

export interface PolicyInput {
	action: PolicyActionKind;
	attribution: Attribution;
	protectedResource: boolean;
	/** Display label for messages: protected label, title, or slug. */
	label: string;
	/** Draft-vs-live analysis. Absent for unpublish (nothing is introduced). */
	analysis?: Analysis;
	config: Config;
}

export interface PolicyDecision {
	result: PolicyAction;
	outcomes: PolicyOutcome[];
	/** Plain-text cancellation reason (1–500 chars) when result is block. */
	reason?: string;
	/** True when monitor mode turned at least one BLOCK into WARN. */
	downgraded: boolean;
}

const RANK: Record<PolicyAction, number> = { allow: 0, warn: 1, block: 2 };
const EMBED_CODES: ReadonlySet<SignalCode> = new Set<SignalCode>([
	"embed.script",
	"embed.inline-script",
	"embed.iframe",
	"embed.object",
	"embed.form",
	"embed.handler",
]);

const VERB: Record<PolicyActionKind, string> = { publish: "Publishing", schedule: "Scheduling", unpublish: "Unpublishing" };

function list(values: readonly string[], max = 3): string {
	const shown = values.slice(0, max).join(", ");
	return values.length > max ? `${shown} and ${values.length - max} more` : shown;
}

function details(analysis: Analysis | undefined, codes: ReadonlySet<SignalCode>): string[] {
	const out: string[] = [];
	for (const s of analysis?.signals ?? []) if (codes.has(s.code) && s.detail && !out.includes(s.detail)) out.push(s.detail);
	return out;
}

/** Evaluate the built-in rules. Pure and deterministic. */
export function evaluatePolicies(input: PolicyInput): PolicyDecision {
	const { config, analysis, attribution } = input;
	const verb = VERB[input.action];
	const subject = input.protectedResource ? `protected resource "${input.label}"` : `"${input.label}"`;
	const outcomes: PolicyOutcome[] = [];
	const add = (rule: PolicyRuleId, reason: string) => {
		const result = config.rules[rule];
		if (result !== "allow") outcomes.push({ rule, result, reason });
	};

	if (analysis && input.action !== "unpublish") {
		const blocked = analysis.hosts.filter((h) => matchesAny(h, config.blockedDomains));
		if (blocked.length) add("blocked-domain", `${verb} ${subject} would put the blocked domain ${list(blocked)} live.`);

		const dangerous = details(analysis, new Set<SignalCode>(["url.javascript", "url.data"]));
		if (dangerous.length) add("dangerous-scheme", `${verb} ${subject} would introduce a dangerous URL scheme (${list(dangerous)}).`);

		if (input.protectedResource) {
			const untrusted = analysis.introducedDomains.filter((d) => d.status === "new" || d.status === "observed").map((d) => d.host);
			if (untrusted.length) add("protected-unknown-domain", `${verb} ${subject} would introduce the untrusted domain ${list(untrusted)}.`);

			const http = details(analysis, new Set<SignalCode>(["url.http"]));
			if (http.length) add("protected-insecure-http", `${verb} ${subject} would introduce insecure http:// links to ${list(http)}.`);

			const embeds = analysis.signals.filter((s) => EMBED_CODES.has(s.code));
			if (embeds.length) {
				const what = [...new Set(embeds.map((s) => s.code.replace("embed.", "")))].join(", ");
				add("protected-embed", `${verb} ${subject} would introduce embedded content (${what}).`);
			}
		}
	}

	if (input.protectedResource) {
		const via = viaPhrase(attribution);
		if (attribution.source === "mcp") add("protected-origin-mcp", `${verb} ${subject} ${via} is restricted by ChangeWard rule protected-origin-mcp.`);
		if (attribution.source === "api") add("protected-origin-api", `${verb} ${subject} ${via} is restricted by ChangeWard rule protected-origin-api.`);
		if (attribution.source === "plugin") add("protected-origin-plugin", `${verb} ${subject} ${via} is restricted by ChangeWard rule protected-origin-plugin.`);
		if (input.action === "unpublish") add("protected-unpublish", `${verb} ${subject} takes it off the live site.`);
	}

	let downgraded = false;
	if (config.mode === "monitor") {
		for (const o of outcomes) {
			if (o.result === "block") {
				o.result = "warn";
				downgraded = true;
			}
		}
	}

	const result = outcomes.reduce<PolicyAction>((acc, o) => (RANK[o.result] > RANK[acc] ? o.result : acc), "allow");
	const decision: PolicyDecision = { result, outcomes, downgraded };
	if (result === "block") {
		const reasons = outcomes.filter((o) => o.result === "block").map((o) => o.reason);
		decision.reason = clampReason(`ChangeWard: ${reasons.join(" ")} Review it, then change the content or the rule in ChangeWard → Policies.`);
	}
	return decision;
}

/** EmDash accepts 1–500 plain-text characters. */
export function clampReason(text: string): string {
	// eslint-disable-next-line no-control-regex
	const plain = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
	return plain.length <= 500 ? plain : `${plain.slice(0, 497)}...`;
}
