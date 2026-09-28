# Privacy

**Your content stays in your CMS.**

ChangeWard has no network capability. It sends no telemetry, analytics or tracking, needs no activation or licence server, and uses no remote threat intelligence. The only outbound path is optional email alerts, delivered by the email provider you configured in EmDash.

## Stored

| Data | Where | Why |
| --- | --- | --- |
| Change summaries ("Pricing" updated via MCP; new external domain (pay.example)) | `events` | Change log |
| Entry IDs, collection slugs, titles (≤120 chars), slugs | `events`, `resources` | Identify what changed |
| EmDash actor IDs and numeric roles, as reported by EmDash | `events`, `incidents` | Attribution |
| SHA-256 fingerprints | `events`, `resources` | Integrity |
| External hostnames and up to 150 link references per entry (`kind|URL`) | `resources`, `state` | Detect introduced domains and changed destinations |
| Redirect sources and destinations (≤200 rules) | KV snapshot | Redirect changes |
| Media filename, MIME type, ID | `events` | Media observations |
| Alert recipient email address (only if you enter one) | settings | Alerts |

## Not stored

- Content bodies or field values, beyond the link references above.
- User names or email addresses. `users:read` is not requested; only the IDs EmDash puts in events are kept.
- IP addresses, user agents, request headers or payloads.
- Secrets or credentials.
- Copies of revisions. EmDash owns revisions; ChangeWard links to the entry.

Stored link references keep only scheme, host, port and path: credentials, query strings and fragments are removed before anything is stored. `javascript:` and `data:` URLs are stored as the scheme plus at most 40 characters, never the full payload.

## Retention

Events are kept 30 days by default (7/30/90/180). Resolved or ignored incident summaries are kept 180 days by default (30/90/180/365). Cleanup runs hourly. See `DATA_MODEL.md`.

## Uninstall

Uninstalling with EmDash's "delete data" option removes ChangeWard's configuration and activity state, and deletes events, incidents and resources in batches. A single sandbox invocation can make only a few storage calls, so very large histories may leave rows behind for EmDash's own plugin-storage cleanup. Uninstalling without "delete data" keeps everything.

## Email alerts

Off by default. When enabled, each digest contains incident IDs, severities and titles (which may include entry titles) and a link to the ChangeWard admin. No content bodies are sent.
