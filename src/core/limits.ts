/**
 * Hard bounds that keep every invocation inside the sandbox budget
 * (50 ms CPU, 10 subrequests). Exceeding an analysis bound marks the
 * result partial; it never throws.
 */
export const LIMITS = {
	/** Bridge calls one invocation may make. The sandbox allows 10; one is kept in reserve. */
	bridgeCalls: 9,
	/** Content tree nodes visited during extraction. */
	walkNodes: 5000,
	walkDepth: 32,
	/** Total string characters scanned for URLs and markup. */
	scanChars: 200_000,
	/** A single string is scanned in full up to the total scan budget. */
	stringChars: 200_000,
	refs: 300,
	storedRefs: 150,
	urlFields: 20,
	eventSignals: 12,
	eventDomains: 10,
	eventPolicies: 6,
	summaryChars: 200,
	titleChars: 120,
	slugChars: 120,
	canonicalNodes: 20_000,
	baselineDomains: 50,
	manyLinks: 20,
	ringEntries: 200,
	ringWindowMs: 15 * 60_000,
	cachedIncidents: 20,
	observedDomains: 500,
	pendingAlerts: 20,
	incidentResources: 20,
	incidentDomains: 20,
	incidentReasons: 10,
	incidentActors: 10,
	domainListEntries: 200,
	pageSize: 20,
	redirectPages: 2,
	redirectPageSize: 100,
	cleanupBatches: 2,
	alertsPerRun: 3,
	notesChars: 500,
	labelChars: 80,
	idChars: 200,
} as const;

/** Attribution window for inheriting a policy decision's origin in an after-hook. */
export const ATTRIBUTION_WINDOW_MS = 120_000;
