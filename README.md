# ChangeWard

**Know what changed. Know who changed it.**

ChangeWard helps EmDash administrators understand and govern important CMS changes. It records where changes came from, monitors protected content, applies publishing policies, surfaces MCP and automation activity, and groups related events into incident timelines.

ChangeWard complements Cloudflare security products. It does not provide a WAF, DDoS protection, bot mitigation, authentication, or network-level MCP security. Its layer is **application-level change provenance**: what state changed inside EmDash, through which origin, and whether that transition breaks your publishing rules. See [docs/CLOUDFLARE_BOUNDARY.md](docs/CLOUDFLARE_BOUNDARY.md).

Author: [Rizvi](https://github.com/mirza-rizvi) · License: MIT · Version 0.1.0 (sandboxed EmDash plugin, EmDash ≥ 1.0)

## What it does

| Pillar | What you get |
| --- | --- |
| **Change intelligence** | Every create, update, publish, unpublish, schedule, trash, delete and restore is recorded with its EmDash origin (MCP, API, visual editor, plugin, scheduler, system) and actor. Each change is diffed for security-relevant properties: new external domains, changed link destinations, `http://`, `javascript:` and `data:` URLs, script, iframe and form references, embed blocks, bursts of links. It also fingerprints content with SHA-256 |
| **Protected content** | Mark Pricing, Legal, Downloads and similar pages as protected: raised severity, a known good state (baseline), and drift reports |
| **MCP & automation activity** | MCP changes today, recent MCP activity, per-origin filters. MCP is labelled MCP, never "AI" |
| **Publishing policies** | Nine rules (blocked domains, dangerous schemes, protected content via MCP/API/plugin, unknown domains, insecure links, embeds, unpublish), each ALLOW / WARN / BLOCK. BLOCK uses EmDash's native publication-policy hook and explains itself. Saving drafts is never blocked |
| **Incident trail** | Unusual change volume per origin and actor. Related changes are correlated into incidents (same resource, same actor, shared domain) with stated reasons, deterministic severity and an open → investigating → resolved/ignored workflow |

Also: redirect changes observed every 15 minutes, lightweight media observations (SVG, HTML, executables, double extensions), optional email digests, configurable retention, an entry-editor panel, and dashboard widgets. ChangeWard's own configuration changes are recorded too.

## Trust

- **Five capabilities**: `content:read`, `hooks.content-policy:register`, `redirects:read`, `media:read`, `email:send`. No `content:write`, no network access. See [docs/CAPABILITIES.md](docs/CAPABILITIES.md).
- **Your content stays in your CMS.** No telemetry, analytics, phone-home or activation server. Stores summaries, hashes and hostnames, not content bodies. See [docs/PRIVACY.md](docs/PRIVACY.md).
- **Measured language.** "External script reference introduced. Review recommended." Never "malware detected".

## Admin

`Overview · Activity · Incidents · Protected · Policies · Settings`, plus the **ChangeWard status** and **Open incidents** dashboard widgets and a **ChangeWard** panel on each entry. All of it is Block Kit, rendered by EmDash.

## Develop

```sh
pnpm install
pnpm run typecheck
pnpm test            # manifest validation + unit + sandbox runtime tests
pnpm run bundle      # registry tarball, enforces size and file limits
```

To try it in a local site: run `pnpm run dev` here, `pnpm add file:../path/to/changeward` in the site, then `import changeward from "changeward"` and pass it to `emdash({ sandboxed: [changeward] })`.

## Documentation

| | |
| --- | --- |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Layers, event and publication flows, key decisions |
| [EMDASH_RESEARCH](docs/EMDASH_RESEARCH.md) | Verified EmDash 1.0.1 APIs, limits, and where the original brief did not match |
| [EMDASH_HOOK_MAP](docs/EMDASH_HOOK_MAP.md) | Every hook: capability, fields, effect, error policy, budget |
| [CLOUDFLARE_BOUNDARY](docs/CLOUDFLARE_BOUNDARY.md) | What Cloudflare owns and ChangeWard does not build |
| [SECURITY_MODEL](docs/SECURITY_MODEL.md) | What is and is not protected, trust assumptions, failure modes |
| [CAPABILITIES](docs/CAPABILITIES.md) · [PRIVACY](docs/PRIVACY.md) · [DATA_MODEL](docs/DATA_MODEL.md) | What is requested, stored and kept |
| [POLICY_ENGINE](docs/POLICY_ENGINE.md) · [INCIDENT_MODEL](docs/INCIDENT_MODEL.md) | Rules, severity table, correlation |
| [PERFORMANCE](docs/PERFORMANCE.md) · [TESTING](docs/TESTING.md) · [DEVELOPMENT](docs/DEVELOPMENT.md) · [PUBLISHING](docs/PUBLISHING.md) | Engineering |

Security reports: see [SECURITY.md](SECURITY.md).
