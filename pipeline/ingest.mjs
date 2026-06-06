#!/usr/bin/env node
/**
 * Defence-AI Radar — ingest pipeline
 * -----------------------------------
 * Dependency-light Node ESM script (Node 20+, global fetch).
 *
 * Pulls free RSS/Atom feeds, keeps only AI-relevant items, maps each to a
 * seed org + themes + region, dedupes by source URL, MERGES with the existing
 * data/events.json (never loses old events), sorts newest-first, and writes
 * a pretty-printed data/events.json.
 *
 * NO LLM anywhere. Pure code: regex parsing + keyword classification.
 *
 * Run:  node pipeline/ingest.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");
const ORGS_PATH = join(DATA_DIR, "orgs.json");
const EVENTS_PATH = join(DATA_DIR, "events.json");

// ---------------------------------------------------------------------------
// Feed catalogue. `region` is the default region for items from this source.
// `fallbacks` are tried in order if the primary URL fails.
// ---------------------------------------------------------------------------
/**
 * Build a Google News RSS *search* feed config for a query.
 * Google News aggregates thousands of outlets, so each query returns 30-100
 * items. `when:30d` limits the window. `orgHint` (optional) biases org-mapping.
 */
function googleNews({ name, query, orgHint = null, region = null }) {
  const q = encodeURIComponent(`${query} when:30d`);
  return {
    name,
    url: `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
    region,
    sourceType: "press",
    google: true,
    orgHint,
    polite: true, // small delay before fetching (avoid rate-limit)
  };
}

const FEEDS = [
  {
    name: "Breaking Defense",
    url: "https://breakingdefense.com/feed/",
    region: "US",
    sourceType: "press",
  },
  {
    name: "DefenseScoop",
    url: "https://defensescoop.com/feed/",
    region: "US",
    sourceType: "press",
  },
  {
    name: "Defense News",
    url: "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml",
    region: "US",
    sourceType: "press",
  },
  {
    name: "The Defense Post",
    url: "https://thedefensepost.com/feed/",
    region: "US",
    sourceType: "press",
  },
  {
    name: "Defense One — Technology",
    url: "https://www.defenseone.com/rss/technology/",
    region: "US",
    sourceType: "press",
  },
  {
    name: "DARPA News",
    url: "https://www.darpa.mil/rss.xml",
    fallbacks: ["https://www.darpa.mil/news.xml"],
    region: "US",
    sourceType: "official",
  },
  {
    name: "UK Gov — Ministry of Defence",
    url: "https://www.gov.uk/search/news-and-communications.atom?organisations%5B%5D=ministry-of-defence",
    region: "UK",
    sourceType: "official",
  },

  // ---- Google News RSS search: THEME queries (broad aggregation) ----------
  googleNews({ name: "Google News — defence AI", query: "defence artificial intelligence" }),
  googleNews({ name: "Google News — military AI", query: "military AI" }),
  googleNews({ name: "Google News — defense AI autonomy", query: "defense AI autonomy" }),
  googleNews({ name: "Google News — military drone AI swarm", query: "military drone AI swarm" }),
  googleNews({ name: "Google News — Pentagon AI", query: "Pentagon AI" }),
  googleNews({ name: "Google News — defence AI contract", query: "defence AI contract" }),

  // ---- Google News RSS search: per-ORG queries (orgHint biases mapping) ----
  googleNews({ name: "Google News — UK MoD AI", query: "UK Ministry of Defence AI", orgHint: "uk-mod" }),
  googleNews({ name: "Google News — Dstl AI", query: "DSTL artificial intelligence", orgHint: "dstl" }),
  googleNews({ name: "Google News — DASA AI", query: "DASA defence innovation AI", orgHint: "dasa" }),
  googleNews({ name: "Google News — DoD CDAO / Maven", query: "DoD Chief Digital AI Office Maven", orgHint: "us-dod-cdao" }),
  googleNews({ name: "Google News — DARPA AI", query: "DARPA artificial intelligence", orgHint: "darpa" }),
  googleNews({ name: "Google News — NATO DIANA AI", query: "NATO DIANA AI", orgHint: "nato-diana" }),
  googleNews({ name: "Google News — EDA AI", query: "European Defence Agency AI", orgHint: "eda" }),
  googleNews({ name: "Google News — BAE Systems AI", query: "BAE Systems artificial intelligence", orgHint: "bae-systems" }),
  googleNews({ name: "Google News — Thales AI", query: "Thales AI defence", orgHint: "thales" }),
  googleNews({ name: "Google News — Anduril", query: "Anduril", orgHint: "anduril" }),
  googleNews({ name: "Google News — Palantir defense AI", query: "Palantir defense AI", orgHint: "palantir" }),
  googleNews({ name: "Google News — Helsing", query: "Helsing defence AI", orgHint: "helsing" }),
];

// ---------------------------------------------------------------------------
// AI relevance — case-insensitive substring match against title + description.
// ---------------------------------------------------------------------------
const AI_KEYWORDS = [
  " ai ",
  "artificial intelligence",
  "machine learning",
  "autonomy",
  "autonomous",
  "generative",
  "large language",
  "drone swarm",
  "drone",
  "algorithm",
  "llm",
  "copilot",
  "isr",
  "targeting",
];

// ---------------------------------------------------------------------------
// Theme classification. Each theme maps to a set of substrings.
// ---------------------------------------------------------------------------
const THEME_RULES = {
  genai: ["generative", "llm", "large language", "chatbot", "foundation model"],
  autonomy: ["autonom", "drone swarm", "uncrewed", "unmanned", "self-driving"],
  isr: ["isr", "surveillance", "reconnaissance", "intelligence, surveillance"],
  ew: ["electronic warfare", "jamming", "jammer", "spectrum"],
  c2: ["command and control", "command & control", "decision", "battle management"],
  cyber: ["cyber"],
  data: ["data", "cloud"],
  "ethics-governance": ["ethic", "responsible", "governance", "policy", "regulation"],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Short, stable id derived from a URL (8 hex chars of sha256). */
function shortHash(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/** Decode the handful of XML/HTML entities we actually meet in feeds. */
function decodeEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#8217;/g, "’")
    .replace(/&#8216;/g, "‘")
    .replace(/&#8220;/g, "“")
    .replace(/&#8221;/g, "”")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // do &amp; LAST so we don't double-decode
}

/** Strip CDATA wrappers and HTML tags, collapse whitespace. */
function cleanText(raw) {
  if (!raw) return "";
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<[^>]+>/g, " "); // drop HTML tags
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim();
}

/** Pull the inner text of the first <tag>…</tag> within a block. */
function tag(block, name) {
  // Handles optional namespace prefix and attributes, e.g. <dc:date ...>.
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${name}>`,
    "i"
  );
  const m = block.match(re);
  return m ? m[1] : "";
}

/**
 * Extract a link from an entry/item block.
 * RSS:  <link>https://…</link>
 * Atom: <link href="https://…" rel="alternate"/>  (prefer rel="alternate" or no rel)
 */
function extractLink(block) {
  // Atom-style self-closing links with href.
  const atomLinks = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  let href = "";
  let fallbackHref = "";
  for (const m of atomLinks) {
    const attrs = m[1];
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const relMatch = attrs.match(/rel\s*=\s*["']([^"']+)["']/i);
    const rel = relMatch ? relMatch[1].toLowerCase() : "";
    if (rel === "alternate" || rel === "") {
      href = hrefMatch[1];
      break;
    }
    if (!fallbackHref) fallbackHref = hrefMatch[1];
  }
  if (href) return decodeEntities(href.trim());
  if (fallbackHref) return decodeEntities(fallbackHref.trim());

  // RSS-style <link>text</link>
  const rss = tag(block, "link");
  return cleanText(rss);
}

/** Parse a date string to ISO YYYY-MM-DD; fall back to today on failure. */
function toISODate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10);
  const d = new Date(raw.trim());
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * Split a feed body into item/entry blocks.
 * Returns an array of raw XML strings, one per <item> or <entry>.
 */
function splitEntries(xml) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(
    (m) => m[1]
  );
  if (items.length) return items;
  const entries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map(
    (m) => m[1]
  );
  return entries;
}

/** Sleep helper (ms) — used to space out Google News requests politely. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalise a headline for title-based dedupe: lowercase, drop a trailing
 * " - source" segment, strip punctuation, collapse whitespace.
 * The same story appears under many Google redirect URLs, so we dedupe on
 * this normalised title in addition to the URL hash.
 */
function normaliseTitle(headline) {
  let s = (headline || "").toLowerCase();
  // Drop a trailing " - Source Name" (Google News appends this).
  s = s.replace(/\s+[-–—]\s+[^-–—]{1,60}$/u, "");
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " "); // strip punctuation
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Google News <item><title> is "Headline - Source Name". Split it into a clean
 * headline and a source name. `sourceTag` (from <source>…</source>) wins for
 * the source name when present.
 */
function parseGoogleTitle(rawTitle, sourceTag) {
  const full = rawTitle || "";
  const m = full.match(/^([\s\S]*?)\s+[-–—]\s+([^-–—]{1,60})$/u);
  let headline = full;
  let trailingSource = "";
  if (m) {
    headline = m[1].trim();
    trailingSource = m[2].trim();
  }
  const sourceName = sourceTag || trailingSource || "Google News";
  return { headline, sourceName };
}

/** Pull the <source url="…">Name</source> source name from a Google item. */
function extractGoogleSource(block) {
  const m = block.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i);
  return m ? cleanText(m[1]) : "";
}

/** True if the combined text mentions any AI keyword. */
function isAIRelevant(text) {
  const hay = ` ${text.toLowerCase()} `;
  return AI_KEYWORDS.some((kw) => hay.includes(kw));
}

/** Assign themes by keyword. Always returns at least an empty array. */
function classifyThemes(text) {
  const hay = text.toLowerCase();
  const themes = [];
  for (const [theme, needles] of Object.entries(THEME_RULES)) {
    if (needles.some((n) => hay.includes(n))) themes.push(theme);
  }
  return themes;
}

/**
 * Map an item to a seed org when the text clearly names one.
 * Returns { org, orgName } — falls back to unmapped + source name.
 */
function mapOrg(text, orgs, sourceName) {
  const hay = text.toLowerCase();
  // Match aliases per org. Order matters only for readability; first hit wins.
  const ALIASES = {
    "uk-mod": ["ministry of defence", "uk mod", "defence ai centre", "uk ministry of defence"],
    dstl: ["dstl", "defence science and technology laboratory", "defence science & technology"],
    dasa: ["dasa", "defence and security accelerator", "defence & security accelerator"],
    "us-dod-cdao": ["cdao", "chief digital and ai office", "chief digital & ai office"],
    darpa: ["darpa"],
    "nato-diana": ["diana", "nato diana"],
    eda: ["european defence agency"],
    "bae-systems": ["bae systems", "bae "],
    thales: ["thales"],
    anduril: ["anduril"],
    palantir: ["palantir"],
    helsing: ["helsing"],
  };
  for (const org of orgs) {
    const aliases = ALIASES[org.slug] || [org.name.toLowerCase()];
    if (aliases.some((a) => hay.includes(a))) {
      return { org: org.slug, orgName: org.name, region: org.region };
    }
  }
  return { org: "unmapped", orgName: sourceName, region: null };
}

/** Fetch a URL and return body text, or throw with a useful message. */
async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      // Some feeds (gov.uk, defensenews CDN) reject the default fetch UA.
      "User-Agent":
        "Mozilla/5.0 (compatible; DefenceAIRadar/1.0; +https://github.com/) ingest-bot",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (!/<(rss|feed|rdf:RDF)\b/i.test(body) && !/<(item|entry)\b/i.test(body)) {
    throw new Error("not XML / no feed items");
  }
  return body;
}

/** Try a feed's primary URL then its fallbacks. Returns { url, body } or null. */
async function loadFeed(feed) {
  const urls = [feed.url, ...(feed.fallbacks || [])];
  for (const url of urls) {
    try {
      const body = await fetchText(url);
      return { url, body };
    } catch (err) {
      console.log(`  · ${feed.name}: ${url} failed (${err.message})`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const orgs = JSON.parse(await readFile(ORGS_PATH, "utf8"));

  // Load existing events (may be empty array).
  let existing = [];
  try {
    existing = JSON.parse(await readFile(EVENTS_PATH, "utf8"));
    if (!Array.isArray(existing)) existing = [];
  } catch {
    existing = [];
  }

  // Index existing events by id so we never lose history.
  const byId = new Map(existing.map((e) => [e.id, e]));
  const startCount = byId.size;

  // Seed the title-dedupe set with existing events so re-runs stay stable and
  // the same story under a different (Google redirect) URL is not re-added.
  const seenTitles = new Set(
    existing.map((e) => normaliseTitle(e.headline)).filter(Boolean)
  );

  // Quick lookup: org slug -> org record (for orgHint resolution).
  const orgBySlug = new Map(orgs.map((o) => [o.slug, o]));

  const feedStatus = [];

  for (const feed of FEEDS) {
    // Be polite to Google News when firing many search queries.
    if (feed.polite) await sleep(250 + Math.floor(Math.random() * 150));

    const loaded = await loadFeed(feed);
    if (!loaded) {
      feedStatus.push({ name: feed.name, ok: false, items: 0 });
      continue;
    }

    const blocks = splitEntries(loaded.body);
    let kept = 0;

    for (const block of blocks) {
      const rawTitle = cleanText(tag(block, "title"));
      // Atom uses <summary> or <content>; RSS uses <description>.
      const descRaw =
        tag(block, "description") ||
        tag(block, "summary") ||
        tag(block, "content");
      const summaryFull = cleanText(descRaw);
      const link = extractLink(block);
      const dateRaw =
        tag(block, "pubDate") ||
        tag(block, "updated") ||
        tag(block, "published") ||
        tag(block, "date");

      if (!rawTitle || !link) continue;

      // For Google News, the title is "Headline - Source"; split it and read
      // the real source from the <source> tag.
      let headline = rawTitle;
      let sourceName = feed.name;
      if (feed.google) {
        const sourceTag = extractGoogleSource(block);
        const parsed = parseGoogleTitle(rawTitle, sourceTag);
        headline = parsed.headline;
        sourceName = parsed.sourceName;
      }

      const corpus = `${headline} ${summaryFull}`;
      if (!isAIRelevant(corpus)) continue;

      // Org mapping: prefer the feed's orgHint when it clearly matches, else
      // fall back to content-based mapping.
      let mapped = mapOrg(corpus, orgs, sourceName);
      if (feed.orgHint && orgBySlug.has(feed.orgHint)) {
        const hintOrg = orgBySlug.get(feed.orgHint);
        // Use the hint when content didn't already map to a (different) org.
        if (mapped.org === "unmapped" || mapped.org === feed.orgHint) {
          mapped = { org: hintOrg.slug, orgName: hintOrg.name, region: hintOrg.region };
        }
      }
      const { org, orgName, region: orgRegion } = mapped;
      const themes = classifyThemes(corpus);
      const region = orgRegion || feed.region;

      const summary =
        summaryFull.length > 300 ? summaryFull.slice(0, 297).trimEnd() + "…" : summaryFull;

      const event = {
        id: shortHash(link),
        date: toISODate(dateRaw),
        org,
        orgName,
        headline,
        summary,
        sourceUrl: link,
        sourceName,
        sourceType: feed.sourceType,
        themes,
        region,
      };

      // Dedupe by id (= hash of sourceUrl) AND by normalised title (the same
      // story shows up under many Google redirect URLs). Keep the first seen.
      const titleKey = normaliseTitle(headline);
      if (byId.has(event.id)) continue;
      if (titleKey && seenTitles.has(titleKey)) continue;

      byId.set(event.id, event);
      if (titleKey) seenTitles.add(titleKey);
      kept++;
    }

    feedStatus.push({ name: feed.name, ok: true, items: kept, url: loaded.url });
  }

  // Merge, sort newest-first (stable tiebreak on headline).
  const merged = [...byId.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.headline.localeCompare(b.headline);
  });

  await writeFile(EVENTS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");

  // ---- Summary -----------------------------------------------------------
  const okFeeds = feedStatus.filter((f) => f.ok);
  const failedFeeds = feedStatus.filter((f) => !f.ok);
  const newCount = merged.length - startCount;

  console.log("\n=== Defence-AI Radar ingest summary ===");
  console.log(`Feeds OK     : ${okFeeds.length}/${feedStatus.length}`);
  for (const f of okFeeds) {
    console.log(`  ✓ ${f.name} — ${f.items} new AI item(s)`);
  }
  if (failedFeeds.length) {
    console.log(`Feeds FAILED : ${failedFeeds.length}`);
    for (const f of failedFeeds) console.log(`  ✗ ${f.name}`);
  }
  console.log(`Total events : ${merged.length}`);
  console.log(`New this run : ${newCount}`);
  console.log("=======================================\n");
}

main().catch((err) => {
  console.error("ingest failed:", err);
  process.exit(1);
});
