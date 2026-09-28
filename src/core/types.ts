export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Origins EmDash reports, plus two ChangeWard-only values for missing or unrecognised data. */
export const ORIGIN_SOURCES = [
	"api",
	"mcp",
	"visual-editor",
	"plugin",
	"scheduler",
	"system",
	"unattributed",
	"unknown",
] as const;
export type OriginSource = (typeof ORIGIN_SOURCES)[number];

export const CATEGORIES = ["content", "publication", "redirect", "media", "policy", "activity", "system"] as const;
export type Category = (typeof CATEGORIES)[number];

export const POLICY_ACTIONS = ["allow", "warn", "block"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const INCIDENT_STATUSES = ["open", "investigating", "resolved", "ignored"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Who or what caused a change, as far as EmDash tells us. Never inferred beyond that. */
export interface Attribution {
	source: OriginSource;
	/** The raw source string when EmDash sent a value this version does not recognise. */
	rawSource?: string;
	pluginId?: string;
	actorId?: string;
	actorRole?: number;
	actorSource?: string;
	/** True when the origin was inherited from a matching publication-policy decision. */
	inherited?: boolean;
}

export type SignalCode =
	| "domain.new"
	| "domain.observed"
	| "domain.trusted"
	| "domain.blocked"
	| "domain.removed"
	| "domain.punycode"
	| "domain.ip"
	| "url.http"
	| "url.javascript"
	| "url.data"
	| "url.changed"
	| "embed.script"
	| "embed.inline-script"
	| "embed.iframe"
	| "embed.object"
	| "embed.form"
	| "embed.handler"
	| "embed.block"
	| "links.many"
	| "integrity.drift"
	| "integrity.match"
	| "analysis.partial"
	| "analysis.first-seen"
	| "media.svg"
	| "media.double-extension"
	| "media.executable"
	| "media.html"
	| "redirect.added"
	| "redirect.removed"
	| "redirect.changed"
	| "redirect.external"
	| "redirect.blocked"
	| "redirect.http"
	| "redirect.partial"
	| "volume.bulk"
	| "policy.warn"
	| "policy.block";

export interface Signal {
	code: SignalCode;
	detail?: string;
}

export interface PolicyOutcome {
	rule: string;
	result: PolicyAction;
	reason: string;
}

export interface ChangeEvent {
	id: string;
	createdAt: string;
	category: Category;
	action: string;
	severity: Severity;
	summary: string;
	originSource: OriginSource;
	originPluginId?: string;
	originInherited?: boolean;
	actorId?: string;
	actorRole?: number;
	actorSource?: string;
	collection?: string;
	resourceId?: string;
	/** `${collection}:${id}`, the index used for per-resource history. */
	resourceKey?: string;
	resourceTitle?: string;
	resourceSlug?: string;
	previousHash?: string;
	currentHash?: string;
	protectedResource: boolean;
	incidentId?: string;
	signals?: Signal[];
	domains?: string[];
	policy?: PolicyOutcome[];
	partial?: boolean;
}

export interface Baseline {
	hash: string;
	domains: string[];
	status: string;
	capturedAt: string;
	capturedBy?: string;
	partial?: boolean;
}

export interface RefMarkers {
	inlineScripts: number;
	inlineHandlers: number;
	embedBlocks: string[];
}

/** Per-resource state. Protected-resource configuration lives on the same record. */
export interface ResourceState {
	key: string;
	collection: string;
	resourceId: string;
	title?: string;
	slug?: string;
	isProtected: boolean;
	protectedAt?: string;
	label?: string;
	notes?: string;
	baseline?: Baseline;
	lastHash?: string;
	/** Compact `${kind}|${href}` references from the last observed state. */
	lastRefs?: string[];
	/** Top-level URL fields and the host they pointed at. */
	lastUrlFields?: Record<string, string>;
	lastMarkers?: RefMarkers;
	lastStatus?: string;
	deleted?: boolean;
	lastSeenAt: string;
	updatedAt: string;
}

export interface Incident {
	id: string;
	title: string;
	status: IncidentStatus;
	severity: Severity;
	createdAt: string;
	updatedAt: string;
	lastEventAt: string;
	eventCount: number;
	originSources: OriginSource[];
	actorIds: string[];
	pluginIds: string[];
	resourceKeys: string[];
	resourceLabels: string[];
	protectedResourceKeys: string[];
	domains: string[];
	reasons: string[];
	primaryResourceKey?: string;
	highEventCount: number;
	/** `source:actor` keys seen in this incident (correlation input). */
	originKeys: string[];
	/** Protected resources that had high-severity events (drives critical escalation). */
	highProtectedKeys: string[];
	statusChangedAt?: string;
	statusChangedBy?: string;
}
