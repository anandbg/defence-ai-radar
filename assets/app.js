/* Defence-AI Radar — front-end.
   Vanilla JS, no deps. Loads data/events.json + data/orgs.json via fetch,
   renders a filterable, searchable reverse-chronological timeline.

   NOTE: fetch() of local JSON needs an http server (see README) — opening
   index.html via file:// will be blocked by the browser. GitHub Pages serves
   it over http, so it works in production. */

(() => {
  "use strict";

  // Human-readable theme labels (keys = theme ids in events.json).
  const THEME_LABELS = {
    genai: "GenAI",
    autonomy: "Autonomy",
    isr: "ISR",
    ew: "Electronic Warfare",
    c2: "Command & Control",
    cyber: "Cyber",
    data: "Data & Cloud",
    "ethics-governance": "Ethics & Governance",
  };

  // How many events to render before the "Load more" button appears, and how
  // many each click reveals. Filters/search always run over the FULL set; this
  // only controls how many of the matched events are painted into the DOM.
  const PAGE_SIZE = 50;

  // ---- Mutable view state (rebuilt into new objects, never deep-mutated) ----
  const state = {
    events: [],
    orgs: [],
    search: "",
    region: "",
    org: "",
    range: "all",
    activeThemes: new Set(),
    visible: PAGE_SIZE, // how many filtered events are currently rendered
  };

  // Human-readable org-type labels (keys = `type` in orgs.json).
  const TYPE_LABELS = {
    gov: "gov",
    alliance: "alliance",
    industry: "industry",
  };
  // Display order for the directory: government & alliances first
  // (the public-sector backbone), then industry. Ties → alphabetical.
  const TYPE_ORDER = { gov: 0, alliance: 1, industry: 2 };

  // ---- DOM handles ----
  const el = {
    search: document.getElementById("search"),
    region: document.getElementById("region"),
    org: document.getElementById("org"),
    range: document.getElementById("range"),
    themes: document.getElementById("themes"),
    timeline: document.getElementById("timeline"),
    counter: document.getElementById("counter"),
    empty: document.getElementById("empty"),
    status: document.getElementById("status"),
    orgDirectory: document.getElementById("org-directory"),
    orgsKicker: document.getElementById("orgs-kicker"),
    loadMoreWrap: document.getElementById("load-more-wrap"),
    loadMore: document.getElementById("load-more"),
  };

  // ---- Helpers ----

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

  /** Days between an ISO date and today. */
  function daysAgo(iso) {
    const then = new Date(iso + "T00:00:00Z").getTime();
    if (isNaN(then)) return Infinity;
    return (Date.now() - then) / 86400000;
  }

  // ---- Filtering ----

  function applyFilters() {
    const q = state.search.trim().toLowerCase();
    const rangeDays = state.range === "all" ? Infinity : Number(state.range);

    return state.events.filter((e) => {
      if (state.region && e.region !== state.region) return false;
      if (state.org && e.org !== state.org) return false;
      if (rangeDays !== Infinity && daysAgo(e.date) > rangeDays) return false;

      // Theme: event must include ALL selected themes (AND semantics).
      if (state.activeThemes.size) {
        const set = new Set(e.themes || []);
        for (const t of state.activeThemes) if (!set.has(t)) return false;
      }

      if (q) {
        const hay = (e.headline + " " + e.summary).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // ---- Rendering ----

  function renderEvent(e, i) {
    const isMapped = e.org && e.org !== "unmapped";
    const orgClass = isMapped ? "org-tag" : "org-tag unmapped";
    // Mapped orgs link to their dossier; "unmapped" stays plain text.
    const orgTag = isMapped
      ? `<a class="${orgClass}" href="org.html?slug=${encodeURIComponent(
          e.org
        )}">${esc(e.orgName)}</a>`
      : `<span class="${orgClass}">${esc(e.orgName)}</span>`;
    const themeChips = (e.themes || [])
      .map(
        (t) =>
          `<span class="theme-chip">${esc(THEME_LABELS[t] || t)}</span>`
      )
      .join("");
    const badgeClass = e.sourceType === "press" ? "badge press" : "badge";
    const sourceLabel = e.sourceType === "official" ? "official" : "press";
    // Cap the reveal stagger so a long list doesn't animate forever.
    const idx = Math.min(i, 18);

    return `
      <article class="event" style="--i:${idx}">
        <div class="event-top">
          <span class="event-date">${esc(fmtDate(e.date))}</span>
          ${orgTag}
          ${
            e.region
              ? `<span class="region-tag" data-region="${esc(
                  e.region
                )}">${esc(e.region)}</span>`
              : ""
          }
        </div>
        <h3 class="event-headline">
          <a href="${esc(safeUrl(e.sourceUrl))}" target="_blank" rel="noopener noreferrer">
            ${esc(e.headline)}
          </a>
        </h3>
        ${e.summary ? `<p class="event-summary">${esc(e.summary)}</p>` : ""}
        <div class="event-bottom">
          ${themeChips}
          <span class="source-name">
            ↗ ${esc(e.sourceName)} ·
            <span class="${badgeClass}">${sourceLabel}</span>
          </span>
        </div>
      </article>`;
  }

  function render() {
    const filtered = applyFilters();
    const sourceCount = new Set(filtered.map((e) => e.sourceName)).size;

    el.counter.textContent = `${filtered.length} event${
      filtered.length === 1 ? "" : "s"
    } from ${sourceCount} source${sourceCount === 1 ? "" : "s"} in view`;

    if (filtered.length === 0) {
      el.timeline.innerHTML = "";
      el.empty.hidden = false;
      if (el.loadMoreWrap) el.loadMoreWrap.hidden = true;
      return;
    }
    el.empty.hidden = true;

    // Render only the first `state.visible` of the filtered set. The rest stay
    // matched in memory and appear when the user clicks "Load more".
    const shown = Math.min(state.visible, filtered.length);
    el.timeline.innerHTML = filtered.slice(0, shown).map(renderEvent).join("");

    renderLoadMore(shown, filtered.length);
  }

  /** Show / hide and label the "Load more" control. */
  function renderLoadMore(shown, total) {
    if (!el.loadMoreWrap || !el.loadMore) return;
    const remaining = total - shown;
    if (remaining <= 0) {
      el.loadMoreWrap.hidden = true;
      return;
    }
    el.loadMoreWrap.hidden = false;
    const next = Math.min(PAGE_SIZE, remaining);
    el.loadMore.innerHTML =
      `Load ${next} more <span class="lm-count">· ${remaining} remaining</span>`;
  }

  /** Reset the visible window whenever the filtered set may have changed, so
      a fresh search/filter always starts at the top of the list. */
  function resetAndRender() {
    state.visible = PAGE_SIZE;
    render();
  }

  /** Terminal-style live status readout in the header.
      Reflects the FULL dataset (not the filtered view). */
  function renderStatus() {
    if (!el.status) return;
    const total = state.events.length;
    const sources = new Set(state.events.map((e) => e.sourceName)).size;
    // Most-recent event date drives the "UPD" stamp.
    const latest = state.events.reduce(
      (acc, e) => (e.date > acc ? e.date : acc),
      "0000-00-00"
    );
    const upd = latest === "0000-00-00" ? "—" : fmtDate(latest);

    el.status.innerHTML =
      `<span class="status-dot" aria-hidden="true"></span>` +
      `<span class="status-text">` +
      `<span class="hot">${total}</span> EVENTS · ` +
      `<span class="cool">${sources}</span> SOURCES · ` +
      `<span class="dim">UPD</span> ${esc(upd)}` +
      `</span>`;
  }

  // ---- Organisations directory (the dossier index) ----

  /** Stable, scannable order: gov & alliance before industry, then A→Z. */
  function orderedOrgs() {
    return state.orgs.slice().sort((a, b) => {
      const ta = TYPE_ORDER[a.type] ?? 99;
      const tb = TYPE_ORDER[b.type] ?? 99;
      if (ta !== tb) return ta - tb;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  function renderOrgCard(o, i) {
    const href = "org.html?slug=" + encodeURIComponent(o.slug);
    const typeLabel = TYPE_LABELS[o.type] || o.type || "";
    // Cap the reveal stagger so the grid doesn't animate forever.
    const idx = Math.min(i, 14);
    return `
      <a class="org-card" href="${esc(href)}" style="--i:${idx}">
        <span class="org-card-name">${esc(o.name)}</span>
        <span class="org-card-badges">
          ${
            o.region
              ? `<span class="org-card-region" data-region="${esc(
                  o.region
                )}">${esc(o.region)}</span>`
              : ""
          }
          ${
            typeLabel
              ? `<span class="org-card-type">${esc(typeLabel)}</span>`
              : ""
          }
        </span>
        <span class="org-card-cta" aria-hidden="true">View dossier →</span>
      </a>`;
  }

  function renderOrgDirectory() {
    if (!el.orgDirectory) return;
    const orgs = orderedOrgs();
    if (el.orgsKicker) {
      el.orgsKicker.textContent =
        "ORGANISATIONS · " +
        orgs.length +
        " dossier" +
        (orgs.length === 1 ? "" : "s");
    }
    el.orgDirectory.innerHTML = orgs.map(renderOrgCard).join("");
  }

  // ---- Populate filter controls from data ----

  function buildOrgOptions() {
    // List ALL orgs so the filter is complete, even those without events yet.
    const frag = document.createDocumentFragment();
    orderedOrgs().forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.slug;
      opt.textContent = o.name;
      frag.appendChild(opt);
    });
    el.org.appendChild(frag);
  }

  function buildThemeChips() {
    // Show every theme that appears in the data.
    const present = new Set();
    state.events.forEach((e) => (e.themes || []).forEach((t) => present.add(t)));
    const order = Object.keys(THEME_LABELS).filter((t) => present.has(t));

    el.themes.innerHTML = order
      .map(
        (t) =>
          `<button class="chip" type="button" data-theme="${esc(
            t
          )}" aria-pressed="false">${esc(THEME_LABELS[t])}</button>`
      )
      .join("");

    el.themes.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const theme = btn.dataset.theme;
        const on = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", on ? "false" : "true");
        if (on) state.activeThemes.delete(theme);
        else state.activeThemes.add(theme);
        resetAndRender();
      });
    });
  }

  // ---- Wire up controls ----

  function bindControls() {
    // Any filter/search change resets the visible window to the first page.
    el.search.addEventListener("input", () => {
      state.search = el.search.value;
      resetAndRender();
    });
    el.region.addEventListener("change", () => {
      state.region = el.region.value;
      resetAndRender();
    });
    el.org.addEventListener("change", () => {
      state.org = el.org.value;
      resetAndRender();
    });
    el.range.addEventListener("change", () => {
      state.range = el.range.value;
      resetAndRender();
    });

    // "Load more" reveals the next page of already-matched events.
    if (el.loadMore) {
      el.loadMore.addEventListener("click", () => {
        state.visible += PAGE_SIZE;
        render();
      });
    }
  }

  // ---- Boot ----

  async function load() {
    try {
      const [events, orgs] = await Promise.all([
        fetch("data/events.json").then((r) => {
          if (!r.ok) throw new Error("events.json HTTP " + r.status);
          return r.json();
        }),
        fetch("data/orgs.json").then((r) => {
          if (!r.ok) throw new Error("orgs.json HTTP " + r.status);
          return r.json();
        }),
      ]);

      state.events = Array.isArray(events) ? events : [];
      state.orgs = Array.isArray(orgs) ? orgs : [];

      renderOrgDirectory();
      buildOrgOptions();
      buildThemeChips();
      bindControls();
      renderStatus();
      render();
    } catch (err) {
      if (el.status) {
        el.status.innerHTML =
          `<span class="status-dot" aria-hidden="true" style="background:var(--warn-red);box-shadow:none"></span>` +
          `<span class="status-text">FEED OFFLINE · ${esc(err.message)}</span>`;
      }
      el.counter.textContent = "";
      el.timeline.innerHTML = "";
      el.empty.hidden = false;
      el.empty.textContent =
        "Could not load data. If you opened this file directly, run a local " +
        "server (e.g. `npx serve`) — browsers block fetch() over file://. " +
        "(" + err.message + ")";
      // Surface for debugging without an LLM in the loop.
      console.error("Defence-AI Radar load error:", err);
    }
  }

  load();
})();
