/* Defence-AI Radar — per-org dossier page.
   Vanilla JS, no deps. Reads ?slug=<slug> from the URL, then fetches the
   synthesised dossier (data/dossiers/<slug>.json), orgs.json and events.json.

   If the dossier JSON is missing (404) we degrade gracefully to a
   "coming soon" view that still shows that org's recent events.

   NOTE: fetch() of local JSON needs an http server (see README) — opening
   org.html via file:// will be blocked by the browser. GitHub Pages serves
   it over http, so it works in production. */

(() => {
  "use strict";

  const DEFAULT_SLUG = "uk-mod";

  // ---- DOM handles ----
  const elRoot = document.getElementById("dossier");

  // ---- Helpers (ported from app.js so the two pages behave identically) ----

  /** Escape text for safe insertion as HTML. */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Only allow http/https hrefs; everything else (javascript:, data:) → "#". */
  function safeUrl(u) {
    const s = String(u == null ? "" : u).trim();
    return /^https?:\/\//i.test(s) ? s : "#";
  }

  /** Format an ISO date (YYYY-MM-DD) as e.g. "05 Jun 2026". */
  function fmtDate(iso) {
    const d = new Date(iso + "T00:00:00Z");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  /** Read a query-string parameter, with a fallback. */
  function getParam(name, fallback) {
    const v = new URLSearchParams(window.location.search).get(name);
    return v && v.trim() ? v.trim() : fallback;
  }

  // ---- Source-link markup, shared by every claim/supplier row ----

  function sourceLink(name, url) {
    if (!url) return "";
    return `<a class="dossier-source" href="${esc(safeUrl(url))}"
      target="_blank" rel="noopener noreferrer">${esc(name || "source")} ↗</a>`;
  }

  // ---- Section renderers ----

  /** A claim list (Established / In progress / Latest share this format). */
  function renderClaimSection(icon, title, items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const rows = items
      .map(
        (it) => `
        <li class="claim">
          <p class="claim-text">${esc(it.claim)}</p>
          <div class="claim-meta">
            ${it.date ? `<span class="claim-date">${esc(fmtDate(it.date))}</span>` : ""}
            ${sourceLink(it.sourceName, it.sourceUrl)}
          </div>
        </li>`
      )
      .join("");
    return `
      <section class="dossier-section">
        <h2 class="dossier-h2">${icon} ${esc(title)}</h2>
        <ul class="claim-list">${rows}</ul>
      </section>`;
  }

  /** Suppliers & partners — a tidy card grid. */
  function renderSuppliers(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const cards = items
      .map(
        (s) => `
        <div class="supplier-card">
          <p class="supplier-name">${esc(s.name)}</p>
          ${s.role ? `<p class="supplier-role">${esc(s.role)}</p>` : ""}
          ${sourceLink(s.sourceName, s.sourceUrl)}
        </div>`
      )
      .join("");
    return `
      <section class="dossier-section">
        <h2 class="dossier-h2">🔗 Suppliers &amp; partners</h2>
        <div class="supplier-grid">${cards}</div>
      </section>`;
  }

  /** Sources — a simple list of links. */
  function renderSources(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const rows = items
      .map(
        (s) => `
        <li>
          <a href="${esc(safeUrl(s.sourceUrl))}" target="_blank"
            rel="noopener noreferrer">${esc(s.name)} ↗</a>
        </li>`
      )
      .join("");
    return `
      <section class="dossier-section">
        <h2 class="dossier-h2">📚 Sources</h2>
        <ul class="source-list">${rows}</ul>
      </section>`;
  }

  /** The distinct "what we don't know" callout. */
  function renderUnknowns(text) {
    if (!text || !String(text).trim()) return "";
    return `
      <aside class="unknowns-box">
        <h2 class="unknowns-h2">⚠️ What we don't yet know</h2>
        <p>${esc(text)}</p>
      </aside>`;
  }

  /** Recent events for this org (from events.json), if any. */
  function renderRecentEvents(events, heading) {
    if (!Array.isArray(events) || events.length === 0) return "";
    const rows = events
      .map(
        (e) => `
        <li class="recent-event">
          <span class="recent-date">${esc(fmtDate(e.date))}</span>
          <a href="${esc(safeUrl(e.sourceUrl))}" target="_blank"
            rel="noopener noreferrer">${esc(e.headline)}</a>
        </li>`
      )
      .join("");
    return `
      <section class="dossier-section">
        <h2 class="dossier-h2">🗞️ ${esc(heading)}</h2>
        <ul class="recent-list">${rows}</ul>
      </section>`;
  }

  // ---- Page renderers ----

  function backLink() {
    return `<a class="back-link" href="index.html">← Back to timeline</a>`;
  }

  /** Full dossier render. */
  function renderDossier(d, orgEvents) {
    const badges = [
      d.region ? `<span class="dossier-badge">${esc(d.region)}</span>` : "",
      d.type ? `<span class="dossier-badge type">${esc(d.type)}</span>` : "",
    ].join("");

    document.title = `${d.name} — Defence-AI Radar`;

    elRoot.innerHTML = `
      ${backLink()}
      <header class="dossier-header">
        <h1 class="dossier-title">${esc(d.name)}</h1>
        <div class="dossier-badges">
          ${badges}
          ${d.updated ? `<span class="dossier-updated">Last updated ${esc(fmtDate(d.updated))}</span>` : ""}
        </div>
      </header>

      ${
        d.overview && String(d.overview).trim()
          ? `<section class="dossier-section">
               <h2 class="dossier-h2">Overview — what we know</h2>
               <p class="dossier-lead">${esc(d.overview)}</p>
             </section>`
          : ""
      }

      ${renderClaimSection("✅", "Established", d.established)}
      ${renderClaimSection("🔧", "In progress", d.inProgress)}
      ${renderClaimSection("📰", "Latest", d.latest)}
      ${renderSuppliers(d.suppliers)}
      ${renderSources(d.sources)}
      ${renderUnknowns(d.unknowns)}
      ${renderRecentEvents(orgEvents, "Recent events")}
    `;
  }

  /** "Coming soon" fallback when the dossier JSON is missing. */
  function renderComingSoon(orgName, orgEvents) {
    document.title = `${orgName} — Defence-AI Radar`;
    elRoot.innerHTML = `
      ${backLink()}
      <header class="dossier-header">
        <h1 class="dossier-title">${esc(orgName)}</h1>
      </header>
      <p class="dossier-lead">
        Dossier coming soon for ${esc(orgName)} — meanwhile, recent events:
      </p>
      ${
        renderRecentEvents(orgEvents, "Recent events") ||
        `<p class="empty">No recent events recorded for this organisation yet.</p>`
      }
    `;
  }

  function renderError(msg) {
    elRoot.innerHTML = `
      ${backLink()}
      <p class="empty">
        Could not load this dossier. If you opened this file directly, run a
        local server (e.g. <code>python3 -m http.server</code>) — browsers
        block fetch() over file://. (${esc(msg)})
      </p>`;
  }

  // ---- Boot ----

  async function load() {
    const slug = getParam("slug", DEFAULT_SLUG);

    try {
      // orgs + events are always needed (events for the "recent" list,
      // orgs to resolve a human-readable name for the fallback view).
      const [orgs, events] = await Promise.all([
        fetch("data/orgs.json").then((r) => (r.ok ? r.json() : [])),
        fetch("data/events.json").then((r) => (r.ok ? r.json() : [])),
      ]);

      const orgList = Array.isArray(orgs) ? orgs : [];
      const eventList = Array.isArray(events) ? events : [];

      // Events for this org, newest first.
      const orgEvents = eventList
        .filter((e) => e.org === slug)
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

      // Try the dossier; a 404 is expected for orgs we haven't synthesised yet.
      const res = await fetch(`data/dossiers/${slug}.json`);
      if (res.ok) {
        const dossier = await res.json();
        renderDossier(dossier, orgEvents);
      } else {
        const match = orgList.find((o) => o.slug === slug);
        const orgName = match ? match.name : slug;
        renderComingSoon(orgName, orgEvents);
      }
    } catch (err) {
      renderError(err.message);
      // Surface for debugging without an LLM in the loop.
      console.error("Defence-AI Radar dossier load error:", err);
    }
  }

  load();
})();
