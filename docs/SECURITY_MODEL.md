# Security model

## What ChangeWard protects

- **Visibility.** A durable, attributed record of important CMS changes: what changed, which EmDash origin produced it, which actor EmDash reported, and what security-relevant properties changed.
- **Publication governance.** Configurable rules that can reject publish, schedule and unpublish transitions for every origin EmDash routes through its policy hooks.
- **Integrity of chosen resources.** SHA-256 fingerprints and known-good baselines for protected content, with drift reporting.
- **Reconstruction.** Deterministic correlation of related changes into incidents with stated reasons.

## What it cannot protect

- **Anything outside the EmDash application boundary**: HTTP traffic, bots, DDoS, authentication, API gateways, browsers, MCP transport, Cloudflare account changes, Git or EmDash Build history. Those layers belong to Cloudflare and EmDash.
- **Saves.** ChangeWard does not block saving (that would need `content:write`). A draft can contain anything; policies apply when it goes live.
- **Actions without a policy hook**: delete, restore and redirect changes are recorded but cannot be prevented.
- **Attribution EmDash does not provide.** Deletes, restores, media uploads and redirect changes arrive without an origin and are shown as *unattributed*. Actor IDs are what EmDash reports; ChangeWard never infers identity, and "MCP" never implies "AI".
- **Malicious content detection.** Observations such as "external script reference introduced" describe a change. They are not a verdict. ChangeWard has no malware engine and does not execute or fetch anything.
- **Content beyond processing limits** (bounded per change; see `src/core/limits.ts`). Those analyses are flagged partial.
- **A compromised administrator**, who can reconfigure or uninstall ChangeWard. ChangeWard does record its own configuration and protection changes as `system` events ("ChangeWard configuration changed: protected-origin-mcp block → allow"; loosening changes are raised to low severity). An administrator can still delete the plugin with its data.

## Capabilities requested

`content:read`, `hooks.content-policy:register`, `redirects:read`, `media:read`, `email:send`. No network access. See `CAPABILITIES.md`.

## Trust assumptions

- EmDash's sandbox, capability bridge and route authorization work as documented. Admin routes are private and require `plugins:manage`.
- EmDash reports `origin` and `actor` truthfully. The visual-editor origin relies on EmDash's signed toolbar token.
- Administrators with `plugins:manage` are trusted to configure policies.
- The site's email provider delivers alerts. ChangeWard has no delivery confirmation.

## Input handling

- Every Block Kit interaction is validated (`src/admin/interaction.ts`, `src/core/validate.ts`). Action IDs, menu values, entry IDs, collection slugs, domains, emails and numbers are checked against strict formats and ranges. Unknown values are rejected with a message, never executed.
- Hidden state is limited to two things, and neither grants authority: the config revision in a form's `block_id`, used as a staleness token for compare-and-set; and the active filter in a table's `block_id`, re-validated against the fixed filter list.
- Stored configuration is re-validated on every read (`normalizeConfig`).
- Content is never rendered as HTML by ChangeWard; Block Kit renders plain text.
- URLs are parsed with the WHATWG URL parser after browser-equivalent preprocessing: control characters are stripped (`java\tscript:`), HTML character references in attributes are decoded (`jav&#x61;script&colon;`), and trailing dots are removed from hosts. The markup scanner handles quoted `>` characters, `srcset`, `meta` refresh, `area`, `button`/`input` `formaction` and SVG `use`. It is a reference extractor, not a sanitizer: URLs assembled at runtime by script are out of scope.

## What is stored

Summaries, hashes, hosts, IDs, roles and short signal details. Not stored: content bodies, email addresses (except the alert recipient an administrator enters), credentials, request payloads, IP addresses or user agents. See `PRIVACY.md`.

## What is sent externally

Nothing, unless email alerts are enabled. Alerts contain incident IDs, severities and titles (entry titles appear in incident titles) and a link to the admin. They go through EmDash's configured email provider.

## Failure behaviour

| Situation | Behaviour |
| --- | --- |
| Observation hook error (after-hooks, media, cron) | Logged by error name only; `errorPolicy: "continue"`; the CMS operation is unaffected |
| Policy hook internal error, default | Allowed (fail open), logged |
| Policy hook internal error, `failClosed` enabled | Rethrown; EmDash's `abort` policy stops the transition with a generic error |
| Hook timeout (5 s) | EmDash's pipeline handles it; for policy hooks under `abort` the transition fails |
| Bridge-call budget exhausted | Lower-priority writes (second incident, resource observation) are skipped; the event is written first |
| Activity-state conflict | Re-read and recompute once; after a second conflict the event is still written without state updates |
| Uninstall with "delete data" | Best-effort deletion within one invocation's budget |

## Future work (tracked, not in V1)

- Signed or exportable audit trail kept outside the site for long-term retention (ChangeWard Cloud).
