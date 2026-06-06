# Defence-AI Radar

**Who's doing what with AI in defence** — a public, self-updating OSINT timeline
tracking AI advancements across the **UK · Europe · US** defence ecosystem.

It is deliberately **simple, static, and searchable**, with **no LLM anywhere**
in the site or the pipeline. Everything is pure code: regex feed parsing plus
keyword classification. It deploys to GitHub Pages with no build step.

---

## What it is

- A single static page (`index.html`) that fetches two JSON files and renders a
  filterable, searchable, reverse-chronological timeline of defence-AI events.
- A daily GitHub Action that re-runs the ingest script, pulling fresh items from
  free public RSS/Atom feeds and committing the updated data back to the repo.
- A deploy Action that republishes the site on every push to `main`.

## Data model

Two JSON files live under `data/`.

### `data/orgs.json`

An array of organisations being tracked:

```json
{ "slug": "darpa", "name": "DARPA", "region": "US", "type": "gov" }
```

- `slug` — stable id used to link events to orgs
- `name` — display name
- `region` — `UK` | `Europe` | `US`
- `type` — `gov` | `alliance` | `industry`

### `data/events.json`

An array of event objects, one per tracked item:

```json
{
  "id": "9bafa2f49c40",
  "date": "2026-03-19",
  "org": "darpa",
  "orgName": "DARPA",
  "headline": "DARPA-developed autonomous helicopter technology transitions to U.S. Army",
  "summary": "An experimental, fly-by-wire H-60Mx Black Hawk … delivered to the U.S. Army for testing.",
  "sourceUrl": "https://www.darpa.mil/news/2026/uh-60mx-black-hawk-army",
  "sourceName": "DARPA News",
  "sourceType": "official",
  "themes": ["autonomy"],
  "region": "US"
}
```

- `id` — short hash of `sourceUrl` (dedupe key)
- `org` — an org `slug`, or `"unmapped"` if no seed org is clearly named
- `summary` — ≤ 300 chars, taken from the feed's own description (never invented)
- `sourceType` — `official` (gov/agency feed) | `press` (trade media)
- `themes` — subset of:
  `genai`, `autonomy`, `isr`, `ew`, `c2`, `cyber`, `data`, `ethics-governance`

## Sources

Free, public RSS/Atom feeds only:

| Source                          | Type     | Region |
| ------------------------------- | -------- | ------ |
| Breaking Defense                | press    | US     |
| DefenseScoop                    | press    | US     |
| Defense News                    | press    | US     |
| DARPA News                      | official | US     |
| UK Gov — Ministry of Defence    | official | UK     |

Items are kept only if their title or description mentions AI-relevant terms
(`artificial intelligence`, `machine learning`, `autonomy`/`autonomous`,
`generative`, `large language`, `drone swarm`, `algorithm`, or a standalone
"AI"). Each kept item is mapped to a seed org when one is clearly named, tagged
with themes by keyword, and assigned a region.

## How it self-updates

1. **`.github/workflows/scrape.yml`** runs daily at 08:00 UTC (and on demand via
   *workflow_dispatch*). It runs `node pipeline/ingest.mjs`, which **merges** new
   items into `data/events.json` (old events are never lost), dedupes by source
   URL, sorts newest-first, and commits the file back if it changed.
2. **`.github/workflows/deploy.yml`** fires on every push to `main` and publishes
   the repo root to GitHub Pages. No build step — the static files are served
   as-is.

So the cron commit → push → deploy chain keeps the live site current with no
human in the loop and no model anywhere.

## Run the ingest locally

Requires **Node 20+** (uses global `fetch`). The pipeline has **zero npm
dependencies**.

```bash
node pipeline/ingest.mjs
```

It prints a summary (feeds OK/failed, total events, new this run) and rewrites
`data/events.json`.

## View the site locally

The page loads JSON with `fetch()`, which browsers **block over `file://`**.
Serve it over http instead:

```bash
npx serve .
# then open the printed http://localhost:… URL
```

Any static server works (`python3 -m http.server`, etc.). On GitHub Pages it is
served over http automatically, so no extra setup is needed in production.

## Enabling GitHub Pages (one-time)

In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**. The
deploy workflow does the rest.

---

## Guardrail: OSINT discipline

This project tracks **public-domain, open-source information only**.

- **Link back to the source.** Every event links to its original page.
- **Never republish paywalled or copyrighted text.** Summaries are short (≤ 300
  chars) and come from the feeds' own public descriptions.
- **No scraping behind logins or paywalls.** Only free, openly published feeds.
- **No LLM, no inference, no fabrication.** The pipeline only filters,
  classifies by keyword, and links. It never generates content.

If a source asks to be removed, delete its entry from `pipeline/ingest.mjs` and
the corresponding events from `data/events.json`.
