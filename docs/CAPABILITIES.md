# Capabilities

Least privilege is a product feature. ChangeWard requests five capabilities and **no network access** (`allowedHosts: []`).

| Capability | Feature requiring it | Data exposed to ChangeWard | Why needed | Can be removed? |
| --- | --- | --- | --- | --- |
| `content:read` | Change log. Required by EmDash for `content:afterSave`, `afterDelete`, `afterPublish`, `afterUnpublish`, `afterSchedule`, `afterUnschedule` and `afterRestore`. Also used to capture and compare baselines (`ctx.content.get`) | Entry identity, slug, status, field data, timestamps | Without it EmDash skips every content after-hook: no change log | No. It is the product |
| `hooks.content-policy:register` | Publishing policies (`content:beforePublish`, `beforeSchedule`, `beforeUnpublish`) | Draft and live data of the entry being published; origin and actor | The only way to reject a publication without write authority | Yes, but ChangeWard becomes monitoring-only and loses origin attribution for publish events |
| `redirects:read` | Redirect visibility (cron snapshot diff) | Redirect rules: source, destination, status, enabled, hit counts | EmDash has no redirect hooks; periodic read is the only observation path | Yes: redirect monitoring disappears. Also switchable off in Settings |
| `media:read` | `media:afterUpload` metadata observations (SVG, HTML, executable, double extension) | Upload metadata: ID, filename, MIME type, size, URL | EmDash requires it for the hook | Yes: media observations disappear. Also switchable off in Settings |
| `email:send` | Optional digest alerts | None read. Sends mail through the site's configured provider | Alerts outside the admin UI without network access of its own | Yes: alerts are off by default; everything else works without it |

## Deliberately not requested

| Capability | Why not |
| --- | --- |
| `content:write` | ChangeWard never modifies content. It would also be required for `content:beforeSave`, which ChangeWard avoids (saves are never blocked) |
| `content:publish`, `content:restore` | No automatic remediation or rollback in V1 |
| `content:revisions:read` | Hooks already carry `liveData`; administrators use EmDash's own revision UI (ChangeWard links to the entry) |
| `schema:read` | Titles are read from common fields (`title`, `name`, `label`, `heading`) |
| `redirects:write`, `media:write`, `media:bytes:read` | Observation only; no byte scanning |
| `users:read` | Actor IDs and roles already arrive in events; no directory lookup, no email addresses |
| `network:request`, `network:request:unrestricted` | Zero external traffic: no telemetry, webhooks, threat feeds or phone-home |
| `comments:*`, `taxonomies:*`, `bylines:read` | Outside V1 change provenance |
| `hooks.email-*`, `hooks.page-fragments:register` | Not a transport, not rendering |

## Admin surfaces and MCP

- Admin pages, widgets and the editor panel use private routes with the `plugins:manage` permission (administrators).
- ChangeWard exposes **no** public routes and **no** MCP tools.

## Changing capabilities

Adding a capability in a future release makes EmDash ask administrators to approve it again. Record the reason here first.
