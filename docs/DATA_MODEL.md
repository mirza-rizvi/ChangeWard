# Data model

All data lives in EmDash's plugin-scoped stores, isolated by plugin ID. Nothing leaves the site except alert emails you enable.

## Storage collections (`emdash-plugin.jsonc`)

### `events`: the change log

One record per meaningful change (`src/core/types.ts` `ChangeEvent`). IDs are time-sortable (`<base36 ms>-<random>`).

| Field | Notes |
| --- | --- |
| `createdAt` | ISO timestamp |
| `category` | `content`, `publication`, `redirect`, `media`, `policy`, `activity` |
| `action` | e.g. `content.updated`, `publication.published`, `policy.block`, `activity.bulk`, `redirect.changed` |
| `severity` | `info` … `high` (events never reach `critical`) |
| `summary` | ≤ 200 chars, plain language |
| `originSource` | `api`, `mcp`, `visual-editor`, `plugin`, `scheduler`, `system`, `unattributed`, `unknown` |
| `originPluginId`, `originInherited` | Plugin origin; whether the origin came from the preceding policy decision |
| `actorId`, `actorRole`, `actorSource` | Exactly as EmDash reported them |
| `collection`, `resourceId`, `resourceKey` | `resourceKey = collection:id` |
| `resourceTitle`, `resourceSlug` | Truncated to 120 chars |
| `previousHash`, `currentHash` | `sha256:<hex>` fingerprints |
| `protectedResource` | Boolean |
| `incidentId` | When correlated |
| `signals` | ≤ 12 `{code, detail}` observations (details are hosts or short descriptions) |
| `domains` | ≤ 10 introduced hosts |
| `policy` | ≤ 6 `{rule, result, reason}` |
| `partial` | Analysis hit a processing limit |

Indexes, each backing a query:

| Index | Query |
| --- | --- |
| `createdAt` | Activity (all), retention cleanup, "changes today" |
| `[originSource, createdAt]` | Activity origin filter, MCP counts and recent MCP activity |
| `[category, createdAt]` | Activity category filter |
| `[action, createdAt]` | "Blocked publications today" |
| `[severity, createdAt]` | Recent important changes, "high severity" filter |
| `[protectedResource, createdAt]` | Protected filter, protected changes today |
| `[resourceKey, createdAt]` | Per-resource history, editor panel |
| `[incidentId, createdAt]` | Incident timeline |

### `incidents`

`Incident` in `src/core/types.ts`: `id` (`CW-1001`…), `title`, `status`, `severity`, timestamps, `eventCount`, and capped lists (`originSources`, `originKeys`, `actorIds`, `pluginIds`, `resourceKeys`, `resourceLabels`, `protectedResourceKeys`, `highProtectedKeys`, `domains`, `reasons`). Indexes: `updatedAt` (list), `[status, updatedAt]` (status filters, open counts, retention).

### `resources`

One record per entry ChangeWard has seen, keyed `collection:id`. It combines the **observation** fields that hooks write (`title`, `slug`, `lastStatus`, `lastHash`, `lastRefs` (≤150 `kind|href`), `lastUrlFields`, `lastMarkers`, `deleted`, `lastSeenAt`) with the **administrator** fields (`isProtected`, `protectedAt`, `label`, `notes`, `baseline`).

Hooks update only the observation fields, with an atomic `updateIf` or a create-only `compareAndSet`, so a deferred hook can never undo a protection change. Indexes: `lastSeenAt` (retention), `[isProtected, protectedAt]` (Protected page, protected count).

`baseline`: `{ hash, domains (≤50, sorted), status, capturedAt, capturedBy?, partial? }`.

## KV (`ctx.kv`)

| Key | Content | Bound |
| --- | --- | --- |
| `state` | Activity state (`src/events/state.ts`): recent-activity ring (≤200 entries, 15 min), correlation cache (≤20 open incidents), observed domains (≤500, most recent), bulk markers, pending alerts (≤20), incident sequence | Read once and compare-and-set once per hook |
| `redirects:snapshot` | Last redirect snapshot (≤200 rules) | Written by the redirect cron |

## Settings (`ctx.settings`)

One key, `config` (`src/core/config.ts`), always written with `compareAndSet` against the revision the administrator's form was rendered with. A stale form is rejected with a message rather than overwriting another administrator's change.

## Retention

| Data | Default | Options |
| --- | --- | --- |
| Events | 30 days | 7, 30, 90, 180 |
| Resolved and ignored incidents | 180 days after last update | 30, 90, 180, 365 |
| Open incidents | Kept until closed | — |
| Unprotected resource records | Removed after event retention without activity | — |
| Protected resource records | Kept while protected | — |

Incident summaries outlive their events, so an incident stays understandable after its timeline expires.
