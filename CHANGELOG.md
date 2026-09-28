# Changelog

## [0.1.0] - Unreleased

First version of ChangeWard as a sandboxed EmDash plugin.

### Added

- Change log for content create, update, publish, unpublish, schedule, unschedule, trash, delete and restore, with EmDash origin and actor attribution. After-hooks inherit the origin from the preceding publication-policy decision.
- Change intelligence: introduced and removed external domains, changed URL fields, `http://`, `javascript:` and `data:` URLs, script, iframe, object and form references, inline scripts and handlers, embed blocks, many new links.
- Domain lists (trusted, blocked) and observed-domain tracking with punycode and IP-literal observations.
- SHA-256 content fingerprints, known-good baselines for protected resources, and drift reporting.
- Protected content management with an entry-editor panel.
- Publishing policies through `hooks.content-policy:register`: nine rules with ALLOW, WARN and BLOCK, monitor mode, fail-open by default and an optional fail-closed mode.
- Unusual change volume detection per origin and actor.
- Incident correlation with stated reasons, deterministic severity, and status workflow.
- Redirect change observation (cron snapshot diff) and media metadata observations.
- Optional email alert digests with cooldown.
- Retention cleanup for events, closed incidents and stale resource records.
- Block Kit admin: Overview, Activity, Incidents, Protected, Policies, Settings; two dashboard widgets.
- Audit events for ChangeWard's own configuration and protection changes.
