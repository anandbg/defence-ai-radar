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

  // ---- Inline-SVG icon set (no external images; crisp at any size) ----
  // Each entry is the inner markup of a 24×24 stroked icon. We keep them
  // simple, single-stroke and on-brand (they inherit currentColor).
  const ICONS = {
    centre:
      '<path d="M3 21h18M5 21V8l7-4 7 4v13M9 21v-5h6v5"/><path d="M9 11h.01M15 11h.01"/>',
    document:
      '<path d="M14 3v5h5"/><path d="M7 3h7l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 13h6M9 17h6"/>',
    book:
      '<path d="M12 6.5C12 5 10.5 4 8 4S4 5 4 5v13s1.5-1 4-1 4 1 4 1 1.5-1 4-1 4 1 4 1V5s-1.5-1-4-1-4 1-4 2.5z"/><path d="M12 6.5V19"/>',
    shield:
      '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    server:
      '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    flask:
      '<path d="M9 3h6M10 3v6L5 18a1.5 1.5 0 0 0 1.3 2.2h11.4A1.5 1.5 0 0 0 19 18l-5-9V3"/><path d="M7.5 14h9"/>',
    target:
      '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    coins:
      '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3"/><ellipse cx="15" cy="14" rx="6" ry="3"/><path d="M9 14v3c0 1.3 1.6 2.4 4 2.8M21 14v5c0 1.7-2.7 3-6 3"/>',
    node:
      '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M18 18l-2-2M18 6l-2 2M6 18l2-2"/>',
  };

  /** Pick an icon key by matching keywords in the item's claim + label.
      Ordered most-specific → most-generic; defaults to a neutral node. */
  function iconKeyFor(claim, label) {
    const t = (String(claim || "") + " " + String(label || "")).toLowerCase();
    const has = (re) => re.test(t);
    if (has(/\b(hq|headquarter|centre|center|in-house|coordinat)\b/)) return "centre";
    if (has(/\b(playbook|guide|how-?to|handbook)\b/)) return "book";
    if (has(/\b(rulebook|jsp|safety|safe|assur|guardrail|responsib|ethic)\b/)) return "shield";
    if (has(/\b(foundry|engine|data|server|model|compute|infrastructur|platform)\b/)) return "server";
    if (has(/\b(experiment|arena|lab|trial|prototyp|test|sandbox)\b/)) return "flask";
    if (has(/\b(target|decide|kill|strike|weapon|asgard)\b/)) return "target";
    if (has(/\b(fund|budget|money|invest|£|\$|contract|procur|framework)\b/)) return "coins";
    if (has(/\b(strateg|plan|policy|playbook|document|publicat|paper|report)\b/)) return "document";
    return "node";
  }

  /** Wrap an icon key in a sized, accessible inline SVG. */
  function iconSvg(key) {
    const inner = ICONS[key] || ICONS.node;
    return (
      '<svg class="tile-icon" viewBox="0 0 24 24" width="22" height="22" ' +
      'fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      inner +
      "</svg>"
    );
  }

  // ---- Source-link markup, shared by every claim/supplier row ----

  function sourceLink(name, url) {
    if (!url) return "";
    return `<a class="dossier-source" href="${esc(safeUrl(url))}"
      target="_blank" rel="noopener noreferrer">${esc(name || "source")} ↗</a>`;
  }

  // ---- Section renderers ----
  // Each section carries a status class (drives the colour-coded kicker +
  // claim accents) and a mono kicker label, for the "classified briefing" feel.

  /** Heading with a mono status kicker + display title. */
  function h2(kicker, icon, title) {
    return (
      `<h2 class="dossier-h2">` +
      `<span class="h2-kicker">${esc(kicker)}</span>` +
      `<span>${icon} ${esc(title)}</span>` +
      `</h2>`
    );
  }

  /** "At a glance" building-blocks strip, built purely from the section's
      data so it scales to every org. One tile per item: icon + short name
      (claim) + one-line label. Only renders when items carry a `label`. */
  function renderTileStrip(items) {
    const tiles = items.filter((it) => it && it.label);
    if (tiles.length === 0) return "";
    const cells = tiles
      .map((it) => {
        const key = iconKeyFor(it.claim, it.label);
        return `
        <li class="bb-tile">
          <span class="bb-icon">${iconSvg(key)}</span>
          <span class="bb-text">
            <span class="bb-name">${esc(it.claim)}</span>
            <span class="bb-label">${esc(it.label)}</span>
          </span>
        </li>`;
      })
      .join("");
    return `
      <div class="bb-strip" aria-label="At a glance">
        <p class="bb-kicker">At a glance · ${tiles.length} building block${
      tiles.length === 1 ? "" : "s"
    }</p>
        <ul class="bb-grid">${cells}</ul>
      </div>`;
  }

  /** One claim row. Rich shape (has `plain`) → title + kicker chip +
      explanation paragraph; plain shape (claim only) → original layout.
      Both forms keep the mono date + source link. */
  function renderClaimItem(it, secClass) {
    const meta = `
      <div class="claim-meta">
        ${it.date ? `<span class="claim-date">${esc(fmtDate(it.date))}</span>` : ""}
        ${sourceLink(it.sourceName, it.sourceUrl)}
      </div>`;

    if (it.plain && String(it.plain).trim()) {
      return `
        <li class="claim claim-rich">
          <div class="claim-head">
            <span class="claim-title">${esc(it.claim)}</span>
            ${
              it.label
                ? `<span class="claim-kicker ${esc(secClass)}-kicker">${esc(
                    it.label
                  )}</span>`
                : ""
            }
          </div>
          <p class="claim-plain">${esc(it.plain)}</p>
          ${meta}
        </li>`;
    }

    return `
      <li class="claim">
        <p class="claim-text">${esc(it.claim)}</p>
        ${meta}
      </li>`;
  }

  /** A claim list (Established / In progress / Latest share this format).
      When the section's items carry rich fields we render an "at a glance"
      tile strip above the detailed list. */
  function renderClaimSection(secClass, kicker, icon, title, items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const strip = renderTileStrip(items);
    const rows = items.map((it) => renderClaimItem(it, secClass)).join("");
    return `
      <section class="dossier-section ${secClass}" id="sec-${esc(secClass)}">
        ${h2(kicker, icon, title)}
        ${strip}
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
      <section class="dossier-section sec-suppliers" id="sec-sec-suppliers">
        ${h2("LINK", "🔗", "Suppliers & partners")}
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
      <section class="dossier-section sec-sources" id="sec-sec-sources">
        ${h2("REF", "📚", "Sources")}
        <ul class="source-list">${rows}</ul>
      </section>`;
  }

  /** The distinct "what we don't know" callout. */
  function renderUnknowns(text) {
    if (!text || !String(text).trim()) return "";
    return `
      <aside class="unknowns-box" id="sec-unknowns">
        <h2 class="unknowns-h2">
          <span class="h2-kicker">GAP</span>
          <span>⚠️ What we don't yet know</span>
        </h2>
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
      <section class="dossier-section sec-recent" id="sec-sec-recent">
        ${h2("LOG", "🗞️", heading)}
        <ul class="recent-list">${rows}</ul>
      </section>`;
  }

  // ---- Page renderers ----

  function backLink() {
    return `<a class="back-link" href="index.html">◂ Back to timeline</a>`;
  }

  /** Sticky section index / status rail (wide screens only).
      Only links to sections that actually rendered. */
  function buildRail(d, hasUnknowns, hasRecent) {
    const items = [];
    if (d.overview && String(d.overview).trim())
      items.push(["#sec-overview", "dim", "Overview"]);
    if (Array.isArray(d.established) && d.established.length)
      items.push(["#sec-sec-established", "green", "Established"]);
    if (Array.isArray(d.inProgress) && d.inProgress.length)
      items.push(["#sec-sec-progress", "amber", "In progress"]);
    if (Array.isArray(d.latest) && d.latest.length)
      items.push(["#sec-sec-latest", "cyan", "Latest"]);
    if (Array.isArray(d.suppliers) && d.suppliers.length)
      items.push(["#sec-sec-suppliers", "cyan", "Suppliers"]);
    if (Array.isArray(d.sources) && d.sources.length)
      items.push(["#sec-sec-sources", "dim", "Sources"]);
    if (hasUnknowns) items.push(["#sec-unknowns", "warn", "Known gaps"]);
    if (hasRecent) items.push(["#sec-sec-recent", "dim", "Recent events"]);

    const rows = items
      .map(
        ([href, dot, label]) =>
          `<li><a href="${href}"><span class="rail-dot ${dot}"></span>${esc(
            label
          )}</a></li>`
      )
      .join("");

    return `
      <nav class="dossier-rail" aria-label="Dossier sections">
        <p class="rail-kicker">Sections</p>
        <ul class="rail-list">${rows}</ul>
      </nav>`;
  }

  /** Full dossier render. */
  function renderDossier(d, orgEvents) {
    const badges = [
      d.region
        ? `<span class="dossier-badge" data-region="${esc(d.region)}">${esc(
            d.region
          )}</span>`
        : "",
      d.type ? `<span class="dossier-badge type">${esc(d.type)}</span>` : "",
    ].join("");

    document.title = `${d.name} — Defence-AI Radar`;

    const unknownsHtml = renderUnknowns(d.unknowns);
    const recentHtml = renderRecentEvents(orgEvents, "Recent events");

    const overviewHtml =
      d.overview && String(d.overview).trim()
        ? `<section class="dossier-section sec-overview" id="sec-overview">
             ${h2("BRIEF", "", "Overview — what we know")}
             <p class="dossier-lead">${esc(d.overview)}</p>
           </section>`
        : "";

    const content =
      `${backLink()}` +
      `<header class="dossier-header">` +
      `<p class="dossier-classmark">OSINT Dossier · Public-domain sources</p>` +
      `<h1 class="dossier-title">${esc(d.name)}</h1>` +
      `<div class="dossier-badges">${badges}` +
      `${
        d.updated
          ? `<span class="dossier-updated">UPD ${esc(fmtDate(d.updated))}</span>`
          : ""
      }` +
      `</div></header>` +
      overviewHtml +
      renderClaimSection("sec-established", "OK", "✅", "Established", d.established) +
      renderClaimSection("sec-progress", "WIP", "🔧", "In progress", d.inProgress) +
      renderClaimSection("sec-latest", "NEW", "📰", "Latest", d.latest) +
      renderSuppliers(d.suppliers) +
      renderSources(d.sources) +
      unknownsHtml +
      recentHtml;

    elRoot.innerHTML =
      `<div class="dossier-layout">` +
      buildRail(d, !!unknownsHtml, !!recentHtml) +
      `<div class="dossier-main">${content}</div>` +
      `</div>`;

    applyStagger();
  }

  /** Set a --i custom property on each top-level dossier block so the CSS
      reveal animation staggers in order. */
  function applyStagger() {
    const main = elRoot.querySelector(".dossier-main");
    if (!main) return;
    Array.prototype.forEach.call(main.children, (node, i) => {
      node.style.setProperty("--i", String(Math.min(i, 12)));
    });
  }

  /** "Coming soon" fallback when the dossier JSON is missing. */
  function renderComingSoon(orgName, orgEvents) {
    document.title = `${orgName} — Defence-AI Radar`;
    const content =
      `${backLink()}` +
      `<header class="dossier-header">` +
      `<p class="dossier-classmark">OSINT Dossier · Awaiting synthesis</p>` +
      `<h1 class="dossier-title">${esc(orgName)}</h1>` +
      `</header>` +
      `<p class="dossier-lead">` +
      `Dossier coming soon for ${esc(orgName)} — meanwhile, recent events:` +
      `</p>` +
      (renderRecentEvents(orgEvents, "Recent events") ||
        `<p class="empty">No recent events recorded for this organisation yet.</p>`);

    elRoot.innerHTML =
      `<div class="dossier-layout"><div class="dossier-main">${content}</div></div>`;
    applyStagger();
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
