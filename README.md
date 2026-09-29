# ChangeWard

[![CI](https://github.com/mirza-rizvi/ChangeWard/actions/workflows/ci.yml/badge.svg)](https://github.com/mirza-rizvi/ChangeWard/actions/workflows/ci.yml)

**Know what changed on your website. Know who changed it.**

Your website is no longer edited only by people. Editors, AI assistants, apps connected through an API, other plugins and scheduled jobs can all change your pages. When your pricing page suddenly links somewhere new, you need to know what happened, who or what did it, and whether it should go live.

ChangeWard is a free plugin for the [EmDash](https://github.com/emdash-cms/emdash) website builder. It keeps a clear, readable history of important changes. It watches the pages you care about most, and it can stop risky changes from being published, with a plain explanation of why.

![ChangeWard overview](docs/images/overview.png)

---

## What it does for you

**📋 A readable history of changes**
Every edit, publish, unpublish, schedule and delete is written down in plain language: *"Pricing" published via MCP* or *"Downloads" updated; new external link to pay.example.net*. You can filter by where the change came from, and see at a glance what matters.

**🛡️ Extra care for your most important pages**
Mark pages like Pricing, Checkout, Downloads or Legal as **protected**. ChangeWard remembers how each one looked when it was right (its *known good state*), and tells you when it drifts away from that.

**✋ Stop risky changes before visitors see them**
Set simple rules, and ChangeWard checks them every time something is about to go live. For example:
- Never publish a link to a website on my blocked list.
- Don't let AI assistants or automated tools publish my protected pages.
- Warn me when a protected page adds a link to a website I haven't approved.

When a rule stops a publish, the person or tool sees exactly why. Drafts can always be saved; rules only apply when something goes live.

![A blocked publish, with ChangeWard's explanation](docs/images/blocked-publish.png)

**🔎 Related changes grouped into one story**
When several changes are connected (the same page, the same person or tool, the same new link) ChangeWard groups them into an **incident**. It shows a timeline and a plain explanation of why the changes were grouped. It also notices unusual bursts, such as fifty edits in a minute.

![An incident with its timeline](docs/images/incident-detail.png)

**🤖 See what automated tools are doing**
A dedicated view shows what came in through **MCP**, the connection AI assistants and other tools use to work with your site. It's labelled honestly as "MCP", because the tool on the other end could be an AI, a script or another app.

**📧 Optional email alerts**
Get a short summary email when something serious happens. It's off by default, and sent at most once per cooldown period, so your inbox doesn't flood.

<details>
<summary><b>More screenshots</b>: activity history, protected pages, rules</summary>

![Activity history](docs/images/activity.png)
![Protected pages](docs/images/protected.png)
![Publishing rules](docs/images/policies.png)

</details>

---

## Built to be trusted

- **Your content stays on your site.** ChangeWard has no internet access at all. No tracking, no analytics, no accounts, no "phone home". The only thing it can send is the optional alert email, through your own site's email setup.
- **It asks for as little access as possible.** It can read your content and check publishing, but it **cannot edit, publish or delete anything**.
- **It keeps notes, not copies.** It stores short summaries, fingerprints and website names, not your page text.
- **It tells you what it saw, not scary guesses.** You'll read "new link to an unknown website, review recommended", never "hacker detected". It describes changes; you decide what they mean.
- **It never gets in the way of editing.** If ChangeWard ever has a problem, your site keeps working and publishing continues normally, unless you've chosen stricter behaviour.

## What it doesn't do

ChangeWard focuses on **changes inside your website**. It works alongside security services like Cloudflare, not instead of them. It is **not**:

- a firewall, spam filter or bot blocker;
- a login or password system;
- a virus or malware scanner.

---

## Getting started

> **Status: early release (0.1.0).** ChangeWard works and is tested on a real EmDash site, but it isn't in the EmDash plugin directory yet.

**Once it's listed:** open your EmDash admin, go to **Registry**, find **ChangeWard**, and click **Install**. EmDash will show you exactly what it's allowed to access before you approve.

**After installing:**
1. Open **ChangeWard** from the admin sidebar.
2. Go to **Protected** and add the pages that matter most, such as Pricing. Keep "capture the current state as known good" switched on.
3. Go to **Policies**, add any websites you trust or want blocked, and choose ALLOW, WARN or BLOCK for each rule.
4. Optional: in **Settings**, turn on email alerts.

## Common questions

**Will it block my editors from saving work?**
No. Saving drafts is never blocked. Rules only apply at the moment something is published, scheduled or unpublished.

**Can it tell which AI made a change?**
It tells you what EmDash reports. For publishing it shows the route, such as MCP (used by AI assistants and other tools), the API, the visual editor, a plugin or the scheduler. For ordinary edits, EmDash only reports which signed-in user made the change, so ChangeWard shows that and doesn't guess.

**Does it slow down my site?**
No. It only does small, bounded work when content changes. It never scans your whole site, and it doesn't touch what visitors load.

**What if I set a rule too strictly?**
Switch Policies to **Monitor only**. Every BLOCK then becomes a warning, so nothing is stopped while you fine-tune. Changes to ChangeWard's own settings are recorded too, so you can always see who loosened a rule.

**How long is history kept?**
30 days by default. You can choose 7, 30, 90 or 180 days in Settings.

## Words you'll see

| Term | Meaning |
| --- | --- |
| **EmDash** | The open-source website builder (CMS) that ChangeWard plugs into |
| **MCP** | A standard way for AI assistants and other tools to connect to your site and make changes |
| **Origin** | The route a change came through: MCP, API, visual editor, a plugin, the scheduler |
| **Protected page** | A page you've marked for extra monitoring and stricter rules |
| **Known good state** | A saved fingerprint of how a protected page looked when it was right |
| **Policy / rule** | A check that runs before something goes live: allow, warn or block |
| **Incident** | A group of related changes worth reviewing together |

---

## For developers

<details>
<summary>Technical details, permissions and build commands</summary>

ChangeWard is a sandboxed EmDash plugin (EmDash ≥ 1.0). Its admin UI is built with Block Kit, and it has no runtime dependencies.

**Capabilities requested:** `content:read`, `hooks.content-policy:register`, `redirects:read`, `media:read`, `email:send`. No `content:write`, no `network:request`. Rationale: [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

```sh
pnpm install
pnpm run typecheck
pnpm test            # manifest validation, unit tests, sandbox runtime tests
pnpm run bundle      # registry tarball; enforces bundle size and file limits
```

Try it on a local site: run `pnpm run dev` here, then `pnpm add file:../path/to/ChangeWard` in the site, then add it with `emdash({ sandboxed: [changeward], sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox" })`.

| Document | Covers |
| --- | --- |
| [Security model](docs/SECURITY_MODEL.md) | What is and isn't protected, trust assumptions, failure behaviour |
| [Capabilities](docs/CAPABILITIES.md) · [Privacy](docs/PRIVACY.md) · [Data model](docs/DATA_MODEL.md) | Access requested, data stored, retention |
| [Policy engine](docs/POLICY_ENGINE.md) · [Incident model](docs/INCIDENT_MODEL.md) | Rules, severity table, grouping logic |

</details>

## Security and license

Found a security problem? Please report it privately. See [SECURITY.md](SECURITY.md).

MIT License © 2026 [Rizvi](https://github.com/mirza-rizvi) · [Changelog](CHANGELOG.md)
