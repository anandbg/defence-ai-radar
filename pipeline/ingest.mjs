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
    name: "Defense One — All",
    url: "https://www.defenseone.com/rss/all/",
    region: "US",
    sourceType: "press",
  },
  {
    name: "C4ISRNET",
    url: "https://www.c4isrnet.com/arc/outboundfeeds/rss/?outputType=xml",
    region: "US",
    sourceType: "press",
  },
  {
    name: "Naval News",
    url: "https://www.navalnews.com/feed/",
    region: "Europe",
    sourceType: "press",
  },
  {
    name: "The War Zone (TWZ)",
    url: "https://www.twz.com/feed",
    region: "US",
    sourceType: "press",
  },
  {
    name: "Task & Purpose",
    url: "https://taskandpurpose.com/feed/",
    region: "US",
    sourceType: "press",
  },
  {
    name: "Defence Blog",
    url: "https://defence-blog.com/feed/",
    region: "Europe",
    sourceType: "press",
  },
  {
    name: "Army Times",
    url: "https://www.armytimes.com/arc/outboundfeeds/rss/?outputType=xml",
    region: "US",
    sourceType: "press",
  },
  {
    name: "Air & Space Forces Magazine",
    url: "https://www.airandspaceforces.com/feed/",
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
];

// ---------------------------------------------------------------------------
// AI relevance — case-insensitive substring match against title + description.
// ---------------------------------------------------------------------------
// STRICT: a genuine AI signal must be present, so general defence news
// (bare drones, ISR, targeting, batteries) without an AI angle is excluded.
const AI_KEYWORDS = [
  " ai ", " ai,", " ai.", " ai-", "(ai)", "a.i.",
  "artificial intelligence",
  "machine learning", "machine-learning", "deep learning", "deep-learning",
  "neural network", "neural net",
  "generative ai", "genai", "gen ai", "generative model",
  "large language", "llm ", "llms",
  "computer vision",
  "autonomy", "autonomous",
  "ai-enabled", "ai-powered", "ai-driven", "ai-based", "ai system", "ai model",
  "ai-augmented", "ai capability", "ai tool", "algorithmic warfare",
  "foundation model", "predictive ai", "agentic",
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
    .replace(/&#8230;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&pound;/g, "£")
    .replace(/&euro;/g, "€")
    .replace(/&deg;/g, "°")
    .replace(/&trade;/g, "™")
    .replace(/&copy;/g, "©")
    .replace(/&reg;/g, "®")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // do &amp; LAST so we don't double-decode
}

/** Decode numeric (&#123; / &#x1F;) HTML entities not covered by the named map. */
function decodeNumericEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _; }
    });
}

/**
 * Strip ALL HTML — tags, CDATA, comments, <script>/<style> bodies — and decode
 * entities, collapsing whitespace. The single source of truth for "no markup".
 * Any value passed through here is guaranteed to contain no "<", ">", "href" or
 * raw entities, so it is always safe to store as a summary.
 */
function stripHtml(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); // unwrap CDATA
  s = s.replace(/<!--[\s\S]*?-->/g, " "); // drop comments
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " "); // drop script/style bodies
  s = s.replace(/<[^>]+>/g, " "); // drop every well-formed tag
  s = s.replace(/<[^>]*$/g, " "); // drop an UNTERMINATED trailing tag (truncated href)
  s = decodeNumericEntities(decodeEntities(s)); // decode named then numeric entities
  s = s.replace(/<[^>]+>/g, " "); // strip tags an entity decoded INTO (e.g. &lt;a&gt;)
  s = s.replace(/<[^>]*$/g, " "); // and any unterminated tag after entity decode
  return s.replace(/\s+/g, " ").trim();
}

/** Backwards-compatible alias used throughout the parser. */
function cleanText(raw) {
  return stripHtml(raw);
}

/**
 * Trim already-clean prose to roughly 2-3 sentences, ending on a sentence
 * boundary and never exceeding `maxChars`. Input MUST be HTML-stripped already.
 */
function toSentences(text, maxSentences = 3, maxChars = 280) {
  let clean = (text || "").trim();
  if (!clean) return "";
  // Strip common WordPress RSS boilerplate footers.
  clean = clean
    .replace(/\s*The post .*?appeared first on .*$/i, "")
    .replace(/\s*\[…\]\s*$/i, "") // a trailing "[…]" read-more marker
    .replace(/\s*Continue reading\b.*$/i, "")
    .trim();
  if (!clean) return "";
  // Protect decimal points so "1.2 seconds" isn't split into two "sentences".
  const DOT = "@@DOT@@"; // sentinel; not present in feed prose
  clean = clean.replace(/(\d)\.(\d)/g, `$1${DOT}$2`);
  const restore = (s) => s.split(DOT).join(".");
  // Split on sentence terminators while keeping them attached.
  const parts = clean.match(/[^.!?]+[.!?]+(?:["'”’)\]]+)?|\S[^.!?]*$/g) || [clean];
  let out = "";
  for (const p of parts) {
    const candidate = (out ? out + " " : "") + p.trim();
    if (candidate.length > maxChars) break;
    out = candidate;
    // Count terminal punctuation reached; stop at the sentence budget.
    const sentenceCount = (out.match(/[.!?]+(?:["'”’)\]]+)?(?:\s|$)/g) || []).length;
    if (sentenceCount >= maxSentences) break;
  }
  if (!out) {
    // No sentence boundary fit: hard-cap on a word boundary.
    out = clean.slice(0, maxChars);
    const lastSpace = out.lastIndexOf(" ");
    if (lastSpace > 60) out = out.slice(0, lastSpace);
    out = out.replace(/[\s,;:]+$/, "") + "…";
  }
  return restore(out.trim());
}

/** Normalise text to alphanumeric tokens for cheap similarity checks. */
function tokenSet(text) {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * True when a candidate description is essentially just the headline (some
 * publishers set og:description to "Headline - SiteName"). Such echoes add no
 * information, so we prefer a real paragraph or the neutral fallback instead.
 */
function isHeadlineEcho(candidate, headline) {
  if (!candidate || !headline) return false;
  const c = tokenSet(candidate);
  const h = tokenSet(headline);
  if (h.size === 0) return false;
  let overlap = 0;
  for (const t of h) if (c.has(t)) overlap++;
  const coverage = overlap / h.size; // share of headline words present
  // Echo if it covers nearly the whole headline and adds little of its own.
  const extra = c.size - overlap; // candidate words not in the headline
  return coverage >= 0.8 && extra <= 4;
}

/** True when a candidate summary is real prose (not a bare link / source stub). */
function isRealProse(text) {
  const s = (text || "").trim();
  if (s.length <= 50) return false;
  if (/^https?:\/\//i.test(s)) return false; // a bare URL
  if (/news\.google\.com/i.test(s)) return false;
  if (/<|>|href=/i.test(s)) return false; // any surviving markup
  // Needs at least a couple of words and some letters.
  return /[a-zA-Z]/.test(s) && s.split(/\s+/).length >= 6;
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

// A defence/military context term must also be present, so generic AI news
// (medical, consumer, business) from the broad aggregator queries is excluded.
const DEFENCE_KEYWORDS = [
  "defence", "defense", "military", "army", "navy", "air force", "armed forces",
  "warfare", "warfighter", "war fighter", "pentagon", "ministry of defence",
  " mod ", " dod ", "nato", "weapon", "missile", "munition", "loitering",
  "soldier", "troops", "combat", "battlefield", "unmanned", "uav", "uas",
  "autonomous weapon", "national security", "department of war", "aukus",
  "dstl", "dasa", "darpa", "diana", "european defence", "maven", "cdao",
  "anduril", "palantir", "helsing", "bae systems", "thales", "rheinmetall",
  "saab", "lockheed", "northrop", "raytheon", "qinetiq", "electronic warfare",
];
/** True only if the text is about AI AND about defence/military (filters generic-AI noise). */
function isAIRelevant(headline, corpus) {
  const head = ` ${(headline || "").toLowerCase()} `;
  const all = ` ${(corpus || headline || "").toLowerCase()} `;
  // The AI signal must be in the HEADLINE so the article is genuinely about
  // AI (not general defence news that merely mentions AI once in the body).
  const aiInHeadline = AI_KEYWORDS.some((kw) => head.includes(kw));
  const def = DEFENCE_KEYWORDS.some((kw) => all.includes(kw));
  return aiInHeadline && def;
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
// Article summaries — build-time, NO LLM. Pure fetch + meta-tag/<p> extraction.
// ---------------------------------------------------------------------------

// Browser-like UA: publisher CDNs frequently 403 a bot UA on the article page.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 8000;
const FETCH_CONCURRENCY = 8;

/** A neutral, URL-free fallback summary. NEVER contains an href or raw link. */
function fallbackSummary(sourceName) {
  const name = (sourceName || "the source").trim() || "the source";
  return `Coverage from ${name}. Open the article to read the full report.`;
}

/** fetch() with an AbortController timeout; resolves to a Response or null. */
async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a content="…" value for a meta tag matched by attr=value, HTML-stripped. */
function metaContent(html, attr, value) {
  // Match the meta tag in either attribute order.
  const re = new RegExp(
    `<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${value}["'][^>]*>`,
    "i"
  );
  const tagMatch = html.match(re);
  if (!tagMatch) return "";
  const c = tagMatch[0].match(/\bcontent\s*=\s*["']([\s\S]*?)["']/i);
  return c ? stripHtml(c[1]) : "";
}

/**
 * Given fetched article HTML, pull the best available description in priority
 * order: og:description → meta description → twitter:description → first
 * substantial <p>. Returns clean prose (HTML-stripped) or "".
 */
function extractArticleDescription(html) {
  if (!html) return "";
  const candidates = [
    metaContent(html, "property", "og:description"),
    metaContent(html, "name", "description"),
    metaContent(html, "name", "twitter:description"),
    metaContent(html, "property", "twitter:description"),
  ];
  for (const c of candidates) {
    if (c && c.length > 50) return c;
  }
  // First substantial paragraph (>60 chars after stripping).
  const paras = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  for (const p of paras) {
    const text = stripHtml(p[1]);
    if (text.length > 60) return text;
  }
  // Any meta description, even short, is better than nothing.
  return candidates.find(Boolean) || "";
}

/**
 * Best-effort resolution of a Google News redirect URL to the real article URL.
 * Modern Google News (AU_yqL… ids) hides the target behind a signed RPC; this
 * tries it and returns the real URL on success, or null. Never throws.
 */
async function resolveGoogleNewsUrl(googleUrl) {
  const seg = googleUrl.match(/\/articles\/([^?]+)/)?.[1];
  if (!seg) return null;
  try {
    const r = await fetchWithTimeout(
      `https://news.google.com/rss/articles/${seg}`,
      { headers: { "User-Agent": BROWSER_UA }, redirect: "follow" }
    );
    if (!r || !r.ok) return null;
    const html = await r.text();
    const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sg || !ts) return null;
    const articles = JSON.stringify([
      "garturlreq",
      [
        ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null,
          [15, null, null, null, null, null, null, [1]],
          "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
        seg, Number(ts), sg,
      ],
    ]);
    const payload = JSON.stringify([[["Fbv4je", articles]]]);
    const r2 = await fetchWithTimeout(
      "https://news.google.com/_/DotsSplashUi/data/batchexecute",
      {
        method: "POST",
        headers: {
          "User-Agent": BROWSER_UA,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: "f.req=" + encodeURIComponent(payload),
      }
    );
    if (!r2 || !r2.ok) return null;
    const txt = await r2.text();
    const m =
      txt.match(/"(https?:\/\/(?:(?!news\.google)[^"\\])+)",null,"/) ||
      txt.match(/\[\\"(https?:(?:(?!news\.google)[^\\])+)\\"/);
    if (!m) return null;
    return m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  } catch {
    return null;
  }
}

/**
 * Fetch an article page and return its clean description prose, or "".
 * For Google News links, first resolve to the real publisher URL.
 */
async function fetchArticleSummary(sourceUrl) {
  let target = sourceUrl;
  if (/news\.google\.com/i.test(sourceUrl)) {
    const real = await resolveGoogleNewsUrl(sourceUrl);
    if (!real) return ""; // can't reach the real article server-side
    target = real;
  }
  const res = await fetchWithTimeout(target, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res || !res.ok) return "";
  const ctype = res.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(ctype)) return "";
  const html = await res.text();
  return extractArticleDescription(html);
}

/** Run async `worker` over `items` with a fixed concurrency limit. */
async function runPool(items, limit, worker) {
  const queue = [...items.entries()];
  async function next() {
    while (queue.length) {
      const [idx, item] = queue.shift();
      await worker(item, idx);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, next);
  await Promise.all(runners);
}

/**
 * Ensure every event has a clean 2-3 sentence summary. Preserves existing good
 * summaries (cache) so a daily run only fetches NEW items. Mutates each event's
 * `summary` to a fresh string (no in-place edit of other fields).
 */
async function ensureSummaries(events) {
  // CACHE: keep an existing summary only if it is genuine fetched/feed prose.
  // Our neutral fallback ("Coverage from …") is NOT cached — we retry fetching
  // it each run so items that were unreachable before can be upgraded later.
  const isCachedGood = (e) => {
    const s = e.summary || "";
    return (
      isRealProse(s) &&
      !s.startsWith("Coverage from ") &&
      !isHeadlineEcho(s, e.headline)
    );
  };
  const needFetch = events.filter((e) => !isCachedGood(e));

  // Re-normalise cached-good summaries through toSentences so the whole file
  // stays within the 2-3 sentence / ~280-char budget and any RSS boilerplate
  // ("The post … appeared first on …") is stripped. Idempotent on clean prose.
  for (const e of events) {
    if (isCachedGood(e)) {
      const trimmed = toSentences(e.summary);
      if (trimmed) e.summary = trimmed;
    }
  }

  let fetched = 0;
  let fellBack = 0;

  await runPool(needFetch, FETCH_CONCURRENCY, async (e) => {
    // (a) Feed's own description, if it is real prose (and not just the headline).
    const feedProse = stripHtml(e._descRaw || "");
    if (isRealProse(feedProse) && !isHeadlineEcho(feedProse, e.headline)) {
      e.summary = toSentences(feedProse);
      fetched++;
      return;
    }
    // (b) Fetch the article (resolving Google News links first).
    let desc = "";
    try {
      desc = await fetchArticleSummary(e.sourceUrl);
    } catch {
      desc = "";
    }
    if (isRealProse(desc) && !isHeadlineEcho(desc, e.headline)) {
      e.summary = toSentences(desc);
      fetched++;
      return;
    }
    // (c) Clean neutral fallback — never a raw href.
    e.summary = fallbackSummary(e.sourceName);
    fellBack++;
  });

  // Final guarantee: nothing slips through with markup or a google link.
  for (const e of events) {
    const s = stripHtml(e.summary || "");
    if (!s || /news\.google\.com|href=/i.test(s) || /^https?:\/\//i.test(s)) {
      e.summary = fallbackSummary(e.sourceName);
    } else {
      e.summary = s;
    }
    delete e._descRaw; // strip the transient field before writing
  }

  // File-wide totals (clearer than just this run's fetch batch).
  const realTotal = events.filter(
    (e) => e.summary && !e.summary.startsWith("Coverage from ")
  ).length;
  const fallbackTotal = events.length - realTotal;

  return { fetched, fellBack, realTotal, fallbackTotal };
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
      if (!isAIRelevant(headline, corpus)) continue;

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

      // Provisional summary from the feed's own description (cleaned). For
      // Google News search items this is just a link stub and will be replaced
      // by a fetched article description (or the neutral fallback) later.
      const provisional = isRealProse(summaryFull) ? toSentences(summaryFull) : "";

      const event = {
        id: shortHash(link),
        date: toISODate(dateRaw),
        org,
        orgName,
        headline,
        summary: provisional,
        sourceUrl: link,
        sourceName,
        sourceType: feed.sourceType,
        themes,
        region,
        // Transient: raw feed description, used by ensureSummaries; not written.
        _descRaw: descRaw,
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

  // Build clean 2-3 sentence summaries (fetched og:description for new items;
  // existing real prose preserved). Concurrency-limited; may take minutes on a
  // first backfill of hundreds of items.
  console.log(`\nBuilding article summaries (concurrency ${FETCH_CONCURRENCY})…`);
  const summaryStats = await ensureSummaries(merged);

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
  console.log(
    `Summaries    : ${summaryStats.realTotal} real (fetched/feed) · ` +
      `${summaryStats.fallbackTotal} neutral fallback ` +
      `(this run: +${summaryStats.fetched} fetched, ${summaryStats.fellBack} fell back)`
  );
  console.log("=======================================\n");
}

main().catch((err) => {
  console.error("ingest failed:", err);
  process.exit(1);
});
