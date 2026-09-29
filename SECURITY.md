# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub: [Report a vulnerability](https://github.com/mirza-rizvi/ChangeWard/security/advisories/new). This is the `security.url` contact in `emdash-plugin.jsonc`. Do not open public issues for vulnerabilities.

Include the ChangeWard version, the EmDash version, the runner (Cloudflare or Node/workerd), and steps to reproduce.

## Scope

In scope: ChangeWard's code in this repository. That covers input validation in admin routes, policy-evaluation bypasses, data exposure beyond `docs/PRIVACY.md`, and incorrect attribution.

Out of scope: EmDash core, the plugin sandbox and registry, Cloudflare products, and vulnerabilities in content that ChangeWard merely reports on.

## Supported versions

The latest published release.

## Design

See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for what ChangeWard protects, what it cannot protect, trust assumptions and failure behaviour, and [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for the requested capabilities.
