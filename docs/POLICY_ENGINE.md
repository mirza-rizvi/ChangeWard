# Policy engine

Source: `src/policies/engine.ts` (pure rules) and `src/policies/decide.ts` (hook integration).

## When policies run

EmDash calls `content:beforePublish`, `content:beforeSchedule` and `content:beforeUnpublish` for manual, API, MCP, plugin, scheduler and system transitions. Scheduled entries are checked again when they become due (origin `scheduler`); a rejection unschedules the entry and EmDash shows the reason on its dashboard. There is no `beforeUnschedule`, so an administrator can always cancel a future publication.

**Saving is never blocked.** ChangeWard analyses saves after the fact and enforces only at the publication transition.

## What is compared

The draft EmDash is about to publish (`content.data`) is compared with the currently live data (`content.liveData`). The question the engine answers is "what would this publication put live that is not live now?". For a first publication everything is new.

## Rules

| Rule | Condition | Default |
| --- | --- | --- |
| `blocked-domain` | The draft contains a host on the blocked list (or a subdomain) | BLOCK |
| `dangerous-scheme` | Publication introduces a `javascript:`/`vbscript:` URL, or a `data:` URL in a link, frame, object, form or script | BLOCK |
| `protected-unknown-domain` | Protected resource introduces a host that is not trusted | WARN |
| `protected-origin-mcp` | Protected resource published, scheduled or unpublished via MCP | WARN |
| `protected-origin-api` | … via the REST API | ALLOW |
| `protected-origin-plugin` | … by a plugin | ALLOW |
| `protected-insecure-http` | Protected resource introduces an external `http://` link | WARN |
| `protected-embed` | Protected resource introduces a script, inline script, iframe, object, form target or inline event handler | WARN |
| `protected-unpublish` | Protected resource is unpublished | WARN |
| `analysis-partial` (fixed) | Content exceeded analysis limits on a protected resource, or while a blocked list exists | WARN (not configurable) |

Origin rules never apply to `visual-editor`, `scheduler` or `system`. A scheduled publication was checked when it was scheduled, and its content rules are checked again when it becomes due.

Each rule is ALLOW, WARN or BLOCK in ChangeWard → Policies.

## Actions

- **BLOCK**: return `{ cancel: true, reason }`. EmDash rejects with `PUBLISH_REJECTED`, `SCHEDULE_REJECTED` or `UNPUBLISH_REJECTED` and shows the reason.
- **WARN**: EmDash has no confirmation flow for plugins, so WARN allows the action, records a `policy.warn` event and surfaces it in ChangeWard.
- **ALLOW**: nothing recorded beyond an in-memory attribution marker used by the after-hook.
- **Monitor mode** turns every BLOCK into WARN without changing the rules.

## Explanations

Every outcome carries the rule ID and a sentence naming the resource, the origin and the specific domain or scheme, for example:

> ChangeWard: Publishing protected resource "Pricing" would introduce the untrusted domain foo.example. Review it, then change the content or the rule in ChangeWard → Policies.

Reasons are plain text clamped to 500 characters (EmDash's limit).

## Failure behaviour

- The decision is computed from configuration, the resource record and the event **before** any state I/O. A failure while recording the decision (state, event or incident writes) is logged and never discards a BLOCK.
- **Default (fail open):** if ChangeWard cannot read its configuration or state, it logs the error name (no content) and allows the transition. Observation must not break publishing.
- **Fail closed (setting):** the error is rethrown. Under EmDash's documented `errorPolicy: "abort"`, the publication stops with a generic failure message. If the configuration itself cannot be read, ChangeWard cannot know this setting and fails open.
- **Partial analysis** (content beyond processing limits): findings that were made still apply. Hosts past the 300-reference cap are still checked against the lists (up to 2,000). The `analysis-partial` WARN tells the administrator that some links could not be checked.
