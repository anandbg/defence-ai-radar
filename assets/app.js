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

  // ---- Mutable view state (rebuilt into new objects, never deep-mutated) ----
  const state = {
    events: [],
    orgs: [],
    search: "",
    region: "",
    org: "",
    range: "all",
    activeThemes: new Set(),
  };

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

  function renderEvent(e) {
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

    return `
      <article class="event">
        <div class="event-top">
          <span class="event-date">${esc(fmtDate(e.date))}</span>
          ${orgTag}
          ${e.region ? `<span class="region-tag">${esc(e.region)}</span>` : ""}
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
            ${esc(e.sourceName)} ·
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
    } from ${sourceCount} source${sourceCount === 1 ? "" : "s"}`;

    if (filtered.length === 0) {
      el.timeline.innerHTML = "";
      el.empty.hidden = false;
      return;
    }
    el.empty.hidden = true;
    el.timeline.innerHTML = filtered.map(renderEvent).join("");
  }

  // ---- Populate filter controls from data ----

  function buildOrgOptions() {
    // Only list orgs that actually appear in the events, for a tidy dropdown.
    const present = new Set(state.events.map((e) => e.org));
    const frag = document.createDocumentFragment();
    state.orgs
      .filter((o) => present.has(o.slug))
      .forEach((o) => {
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
        render();
      });
    });
  }

  // ---- Wire up controls ----

  function bindControls() {
    el.search.addEventListener("input", () => {
      state.search = el.search.value;
      render();
    });
    el.region.addEventListener("change", () => {
      state.region = el.region.value;
      render();
    });
    el.org.addEventListener("change", () => {
      state.org = el.org.value;
      render();
    });
    el.range.addEventListener("change", () => {
      state.range = el.range.value;
      render();
    });
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

      buildOrgOptions();
      buildThemeChips();
      bindControls();
      render();
    } catch (err) {
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
