# Incident model

Source: `src/core/severity.ts`, `src/incidents/correlate.ts`, `src/incidents/volume.ts`.

## Event severity (deterministic)

Each observation has a base severity; the event takes the highest.

| Observation | Ordinary content | Protected resource |
| --- | --- | --- |
| No observation | info | low (human origins) / medium (MCP, API, plugin) |
| Delete, trash or unpublish | info | medium |
| New domain, punycode, IP literal, `http://` link, URL destination changed, many new links, embed block, baseline drift | low | at least low/medium as above |
| Blocked domain, `data:` URL, script/inline-script | medium | **high** |
| iframe, object, form target, inline handler | medium | medium; **high** when published or scheduled |
| `javascript:` URL | high | high |
| Media: SVG | low | — |
| Media: HTML, executable, double extension | medium | — |
| Redirect added, removed, changed, or to `http://` | low | — |
| Redirect newly external | medium | — |
| Redirect to a blocked domain | high | — |
| Unusual change volume | medium | high |
| Policy WARN | low | medium |
| Policy BLOCK | medium | high |

Publishing or scheduling a protected resource that carries any medium observation raises the event to high. **A single event is never critical.**

Examples from the brief, as implemented and tested:

| Scenario | Result |
| --- | --- |
| Normal content edit | info |
| New domain on an ordinary article | low |
| Protected Pricing changed via MCP | medium |
| Protected Pricing + blocked domain + publication | high |
| High-severity changes to two protected resources correlated | critical (incident) |

## Unusual change volume

Sliding windows over the recent-activity ring, per **origin key** (`source:actorId`, or `source:pluginId`):

| Check | Default |
| --- | --- |
| Changes within 60 s | 20 |
| Changes within 5 min | 60 |
| Publish, unpublish and delete within 5 min | 15 |
| Protected-resource changes within 5 min | 8 |

The defaults sit above a human editor's pace but let agents batch-edit a handful of entries without noise. One bulk event is emitted per origin key per 5-minute window. It is phrased "Unusual change volume", never "attack".

## Correlation

Candidates are only the open or investigating incidents cached in the activity state (≤ 20) whose last event falls within the **correlation window** (default 10 min, max 15). No history scan.

Link reasons:

1. **Same resource**: the incident already involves this `collection:id`.
2. **Same origin and actor**: the same `source:actor` key (only when an actor or plugin is known; `unattributed:-` never links).
3. **Shared domain**: an introduced host already in the incident.

Rules:

- A **noteworthy** event (severity ≥ medium) joins the best-matching incident with any reason, or opens a new one.
- An **ordinary** event joins only through the same resource or the same identified actor. A shared domain alone is not enough.
- Ties go to the incident with more reasons, then the most recently active.

Each incident stores its reasons ("Opened by: …", "Same resource (Pricing)", "Same origin and actor (mcp:u1)", "Shared domain pay.example", "Within 10 min of the previous event") and shows them on the incident page.

## Incident severity

1. Highest event severity.
2. At least **high** when medium-or-worse activity spans 3+ protected resources.
3. **Critical** when high-severity events touched 2+ distinct protected resources.

## States

`open → investigating | resolved | ignored`, `investigating → open | resolved | ignored`, `resolved → open`, `ignored → open`.

Transitions use a guarded update: the change applies only if the status is still what the administrator saw. Status changes only affect ChangeWard's records and never touch content. Resolving or ignoring removes the incident from the correlation cache, so later activity opens a new incident rather than reopening a closed one.
