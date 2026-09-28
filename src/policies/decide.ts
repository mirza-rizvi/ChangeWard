import { LIMITS } from "../core/limits";
import type { Store } from "../core/store";
import type { Signal } from "../core/types";
import { isRecord } from "../core/validate";
import { attributionFromPolicy, viaPhrase } from "../events/origin";
import { applyToState, commitState, persistOutcome, resourceKeyOf, type DraftEvent } from "../events/pipeline";
import { displayLabel, titleOf } from "../events/recorder";
import { classifyChange, snapshotOf } from "../intelligence/classify-change";
import { hostOf } from "../intelligence/domains";
import { extract } from "../intelligence/urls";
import { evaluatePolicies, type PolicyActionKind, type PolicyDecision } from "./engine";

export interface PolicyHookEvent {
	content: unknown;
	collection: unknown;
	origin: unknown;
	actor?: unknown;
}

const VERB: Record<PolicyActionKind, string> = { publish: "publish", schedule: "schedule", unpublish: "unpublish" };

/**
 * Evaluate a publication transition and record the decision. Budget: config 1, resource 1,
 * state 2 (+2), event ≤1, incident ≤1 → at most 8.
 *
 * The draft is compared with the live data EmDash sends (`content.liveData`), so the analysis
 * answers "what would this publication put live that is not live now?".
 */
export async function decidePublication(store: Store, kind: PolicyActionKind, event: PolicyHookEvent, now = Date.now()): Promise<PolicyDecision> {
	const content = isRecord(event.content) ? event.content : {};
	const collection = typeof event.collection === "string" ? event.collection : "";
	const id = typeof content.id === "string" ? content.id : "";
	const attribution = attributionFromPolicy(event.origin, event.actor);
	const config = await store.config();
	const key = resourceKeyOf(collection, id);
	const resource = collection && id ? await store.resource(key) : null;
	const isProtected = resource?.isProtected === true;
	const siteHost = hostOf(store.host.site.url);
	const title = titleOf(content);
	const slug = typeof content.slug === "string" ? content.slug.slice(0, LIMITS.slugChars) : undefined;
	const label = displayLabel(resource, title, slug, key);

	const outcome = await commitState(store, (state) => {
		let analysis;
		if (kind !== "unpublish" && isRecord(content.data)) {
			const before = isRecord(content.liveData) ? snapshotOf(extract(content.liveData, siteHost)) : null;
			analysis = classifyChange(before, extract(content.data, siteHost), {
				trusted: config.trustedDomains,
				blocked: config.blockedDomains,
				observed: new Set(Object.keys(state.observed)),
			});
		}
		const decision = evaluatePolicies({ action: kind, attribution, protectedResource: isProtected, label, ...(analysis ? { analysis } : {}), config });
		const pending = { action: kind, ...attribution };
		delete (pending as { inherited?: boolean }).inherited;
		const signals: Signal[] = [];
		if (decision.result !== "allow") {
			signals.push({ code: decision.result === "block" ? "policy.block" : "policy.warn", detail: decision.outcomes.map((o) => o.rule).join(", ") });
			for (const s of analysis?.signals ?? []) if (s.code !== "domain.trusted" && s.code !== "domain.observed") signals.push(s);
		}
		const blocked = decision.result === "block";
		const draft: DraftEvent = {
			category: "policy",
			action: blocked ? "policy.block" : "policy.warn",
			actionClass: "policy",
			summary: blocked
				? `Request to ${VERB[kind]} "${label}" ${viaPhrase(attribution)} was blocked by policy`
				: `Policy warning: ${VERB[kind]} "${label}" ${viaPhrase(attribution)}${decision.downgraded ? " (monitor mode)" : ""}`,
			attribution,
			signals,
			protectedResource: isProtected,
			collection,
			resourceId: id,
			...(title ? { resourceTitle: title } : {}),
			...(slug ? { resourceSlug: slug } : {}),
			domains: analysis?.introducedDomains.map((d) => d.host) ?? [],
			policy: decision.outcomes,
			severity: blocked ? (isProtected ? "high" : "medium") : isProtected ? "medium" : "low",
			trigger: decision.outcomes[0]?.reason ?? "Publication policy",
			pendingAttribution: pending,
			// An allowed transition only leaves an attribution marker for the after-hook.
			ephemeral: decision.result === "allow",
			...(analysis?.partial ? { partial: true } : {}),
		};
		return { ...applyToState(state, draft, config, now), decision };
	});

	await persistOutcome(store, outcome);
	return outcome.decision;
}
