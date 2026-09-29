# ChangeWard

[![CI](https://github.com/mirza-rizvi/ChangeWard/actions/workflows/ci.yml/badge.svg)](https://github.com/mirza-rizvi/ChangeWard/actions/workflows/ci.yml)

ChangeWard is a plugin for the [EmDash](https://github.com/emdash-cms/emdash) website builder. It records changes to your site's content, lets you mark important pages for closer monitoring, and can stop a page from being published when it breaks a rule you set.

![ChangeWard overview](docs/images/overview.png)

## Features

### Change history

Every create, edit, publish, unpublish, schedule, delete and restore is logged as a short sentence, for example `"Downloads" updated; new external link (pay.example.net)`. Each entry shows where the change came from: an editor, an AI assistant or tool connected over MCP, the API, a plugin or the scheduler.

### Protected pages

Mark pages such as Pricing, Checkout or Legal as protected. Changes to them are flagged with higher severity, and ChangeWard tells you when a page no longer matches the version you saved.

### Publishing rules

Rules are checked whenever a page is published, scheduled or unpublished. Each rule can be set to allow, warn or block. For example:

- Block publishing when a page links to a website on your blocked list.
- Block publishing of protected pages when the request comes over MCP.
- Warn when a protected page adds a link to a website you haven't marked as trusted.

When a rule blocks a publish, the reason is shown to whoever tried to publish. Saving drafts is never blocked.

![A blocked publish showing ChangeWard's reason](docs/images/blocked-publish.png)

### Incidents

Related changes are grouped into an incident, such as edits to the same page, or by the same user or tool. Each incident shows a timeline and why its changes were grouped. Unusually fast bursts of changes are flagged too.

![An incident with its timeline](docs/images/incident-detail.png)

### Email alerts

Get an email when an incident reaches a severity you choose. Off by default.

<details>
<summary>More screenshots</summary>

![Activity history](docs/images/activity.png)
![Protected pages](docs/images/protected.png)
![Publishing rules](docs/images/policies.png)

</details>

## Privacy

ChangeWard has no internet access and sends no tracking data. It cannot edit, publish or delete content. It stores short summaries of changes, not the text of your pages.

## Getting started

ChangeWard is not yet listed in the EmDash plugin directory. Once it is, install it from **Registry** in the EmDash admin.

After installing:

1. Open **ChangeWard** in the admin sidebar.
2. Under **Protected**, add the pages that matter most.
3. Under **Policies**, list any trusted or blocked websites and set each rule to allow, warn or block.
4. Optionally, turn on email alerts under **Settings**.

## Questions

**Does it stop editors from saving?**
No. Rules only run when something is published, scheduled or unpublished.

**What if a rule is too strict?**
Set Policies to **Monitor only**. Blocking rules will then warn instead.

**How long is history kept?**
30 days by default. You can change this in Settings.

## For developers

<details>
<summary>Build commands and technical documents</summary>

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run bundle
```

- [Capabilities](docs/CAPABILITIES.md)
- [Security model](docs/SECURITY_MODEL.md)
- [Privacy](docs/PRIVACY.md)
- [Data model](docs/DATA_MODEL.md)
- [Policy engine](docs/POLICY_ENGINE.md)
- [Incident model](docs/INCIDENT_MODEL.md)

</details>

## Security and license

To report a security problem, see [SECURITY.md](SECURITY.md).

MIT License, © 2026 [Rizvi](https://github.com/mirza-rizvi).
