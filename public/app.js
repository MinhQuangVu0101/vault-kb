const $ = (id) => document.getElementById(id);
const results = $("results");
const detail = $("detail");
const statPills = $("stat-pills");
const lastSync = $("last-sync");
const qInput = $("q");
const modeSwitch = $("mode-switch");
const folderInput = $("folder");
const tagInput = $("tag");
const chipAll = $("chip-all");
const backlinksList = $("backlinks-list");
const suggestList = $("suggest-list");
const relatedList = $("related-list");
const identityBadge = $("identity-badge");
const viewNav = $("view-nav");
const themeToggle = $("theme-toggle");
const orphansResults = $("orphans-results");
const orphansDetail = $("orphans-detail");
const deadLinksResults = $("dead-links-results");
const deadLinksDetail = $("dead-links-detail");
const graphCanvas = $("graph-canvas");

let activePath = null;
let activeView = "search";
let searchMode = "search"; // "search" or "semantic"
let graphInstance = null;
let graphLoaded = false;

/* THEME */
const THEME_KEY = "vault-kb-theme";
function applyTheme(theme) {
  document.documentElement.classList.toggle("theme-dark", theme === "dark");
  document.documentElement.classList.toggle("theme-light", theme !== "dark");
  if (!themeToggle) return;
  themeToggle.textContent = theme === "dark" ? "☀" : "🌙";
  themeToggle.title = `Switch to ${theme === "dark" ? "light" : "dark"}`;
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* private mode */ }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const theme = saved ?? (prefersDark ? "dark" : "light");
  applyTheme(theme);
}
function toggleTheme() {
  const next = document.documentElement.classList.contains("theme-dark") ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  // Rebuild graph with the new palette. If the Graph tab is currently
  // visible, re-render immediately; otherwise just reset state so the
  // next visit picks up the new colors.
  graphLoaded = false;
  graphInstance = null;
  if (activeView === "graph" && graphCanvas) {
    graphCanvas.innerHTML = '<div class="graph-empty">Loading…</div>';
    loadGraph();
  }
}
themeToggle?.addEventListener("click", toggleTheme);
initTheme();

/* MODE SWITCH */
modeSwitch?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  searchMode = btn.dataset.mode;
  for (const b of modeSwitch.querySelectorAll("button")) {
    b.classList.toggle("on", b === btn);
  }
});

/* CLEAR-FILTER CHIP */
chipAll?.addEventListener("click", () => {
  folderInput.value = "";
  tagInput.value = "";
});

function switchView(name) {
  if (!["search", "graph", "orphans", "dead-links"].includes(name)) return;
  activeView = name;
  for (const btn of viewNav.querySelectorAll(".view-tab")) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  for (const section of document.querySelectorAll("#content-pane .view")) {
    section.classList.toggle("hidden", section.id !== `view-${name}`);
  }
  if (name === "orphans") loadOrphans();
  else if (name === "dead-links") loadDeadLinks();
  else if (name === "graph") loadGraph();
}

async function fetchJson(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `${res.status} ${res.statusText}`);
  return json;
}

async function loadStats() {
  try {
    const s = await fetchJson("/api/stats");
    const indexed = s.indexed ?? 0;
    const scanned = s.scannedMarkdownFiles ?? indexed;
    const embedCovered = Math.min(s.embeddings.covered ?? 0, indexed);
    const watcherOn = s.watcher?.active;
    const pills = [
      `<span class="pill" title="${indexed} notes opted-in with ai-access: true (out of ${scanned} markdown files scanned)"><span class="dot"></span>${indexed} / ${scanned} ai-access</span>`,
      `<span class="pill" title="${embedCovered} of ${indexed} indexed notes have semantic embeddings"><span class="dot"></span>${embedCovered} / ${indexed} embedded</span>`,
      `<span class="pill ${watcherOn ? "" : "warn"}" title="${watcherOn ? "Auto-reindex on file change" : "Auto-reindex disabled (started with --no-watcher)"}"><span class="dot"></span>watcher ${watcherOn ? "on" : "off"}</span>`,
    ];
    if (s.embeddings.reachable === false) {
      pills.push(`<span class="pill warn"><span class="dot"></span>ollama unreachable</span>`);
    }
    statPills.innerHTML = pills.join("");
    lastSync.textContent = s.lastIngest ? `last sync · ${new Date(s.lastIngest).toLocaleTimeString()}` : "";
  } catch (err) {
    console.warn("loadStats failed:", err);
    statPills.innerHTML = `<span class="pill warn">stats error</span>`;
    lastSync.textContent = "";
  }
}

function renderHits(rows) {
  results.innerHTML = "";
  if (!rows.length) {
    results.innerHTML = '<p class="hint">No results.</p>';
    return;
  }
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "hit" + (row.path === activePath ? " active" : "");
    const scoreBadge = typeof row.score !== "undefined" ? `<span class="badge">${Number(row.score).toFixed(2)}</span>` : "";
    const backlinkBadge = typeof row.backlinkCount === "number" ? `<span class="badge">${row.backlinkCount} ←</span>` : "";
    el.innerHTML = `
      <div class="title">${escape(row.title)}${scoreBadge}${backlinkBadge}</div>
      <div class="path">${escape(row.path)}</div>
      <div class="meta">${escape([row.type, row.area, row.status, row.updated].filter(Boolean).join(" · "))}</div>
      <div class="excerpt">${escape(row.snippet ?? row.excerpt ?? "")}</div>
    `;
    el.addEventListener("click", () => openNote(row.path));
    results.appendChild(el);
  }
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function doSearch() {
  const q = qInput.value.trim();
  if (!q) return;
  document.body.classList.remove("note-open");
  activePath = null;
  const mode = searchMode;
  const params = new URLSearchParams({ q });
  if (folderInput.value.trim()) params.set("folder", folderInput.value.trim());
  if (tagInput.value.trim()) params.set("tag", tagInput.value.trim());
  results.innerHTML = '<p class="hint">Searching…</p>';
  try {
    const json = await fetchJson(`/api/${mode}?${params}`);
    renderHits(json.rows ?? []);
  } catch (err) {
    results.innerHTML = `<div class="error">${escape(err.message)}</div>`;
  }
}

function renderBacklinks(note) {
  const items = (note.backlinks ?? []);
  if (!items.length) {
    backlinksList.innerHTML = '<li class="hint">none</li>';
    return;
  }
  backlinksList.innerHTML = items
    .map((b) => `<li><a data-path="${escape(b.path)}">${escape(b.title ?? b.path)}</a></li>`)
    .join("");
  backlinksList.querySelectorAll("a[data-path]").forEach((a) => {
    a.addEventListener("click", (e) => { e.preventDefault(); openNote(a.dataset.path); });
  });
}

async function loadSuggestions(path) {
  suggestList.innerHTML = '<li class="hint">Loading…</li>';
  try {
    const json = await fetchJson(`/api/suggest-links?path=${encodeURIComponent(path)}&limit=5`);
    if (activePath !== path) return;
    const rows = json.rows ?? [];
    if (!rows.length) {
      suggestList.innerHTML = '<li class="hint">No suggestions above threshold.</li>';
      return;
    }
    suggestList.innerHTML = rows.map((r) => {
      const reason = r.reason ? `<div class="reason">${escape(r.reason)}</div>` : "";
      return `
        <li class="suggestion">
          <div class="title-row">
            <a data-path="${escape(r.path)}">${escape(r.title)}</a>
            <span class="badge">${Number(r.score).toFixed(2)}</span>
          </div>
          ${reason}
        </li>
      `;
    }).join("");
    suggestList.querySelectorAll("a[data-path]").forEach((a) => {
      a.addEventListener("click", (e) => { e.preventDefault(); openNote(a.dataset.path); });
    });
  } catch (err) {
    if (activePath !== path) return;
    suggestList.innerHTML = `<li class="error">${escape(err.message)}</li>`;
  }
}

async function loadRelated(path) {
  relatedList.innerHTML = '<li class="hint">Loading…</li>';
  try {
    const json = await fetchJson(`/api/related?path=${encodeURIComponent(path)}&limit=5`);
    if (activePath !== path) return;
    const rows = json.rows ?? [];
    if (!rows.length) {
      relatedList.innerHTML = '<li class="hint">No related notes.</li>';
      return;
    }
    relatedList.innerHTML = rows.map((r) => `
      <li class="suggestion">
        <div class="title-row">
          <a data-path="${escape(r.path)}">${escape(r.title)}</a>
          <span class="badge">${Number(r.score).toFixed(2)}</span>
        </div>
      </li>
    `).join("");
    relatedList.querySelectorAll("a[data-path]").forEach((a) => {
      a.addEventListener("click", (e) => { e.preventDefault(); openNote(a.dataset.path); });
    });
  } catch (err) {
    if (activePath !== path) return;
    relatedList.innerHTML = `<li class="error">${escape(err.message)}</li>`;
  }
}

async function loadIdentity() {
  try {
    const json = await fetchJson("/api/identity");
    if (!json.email) return;
    identityBadge.innerHTML = `
      <span class="email">📧 ${escape(json.email)}</span>
      <a href="/cdn-cgi/access/logout">logout</a>
    `;
    identityBadge.classList.remove("hidden");
  } catch (err) {
    // /api/identity should never throw under normal conditions; leave badge hidden if it does.
  }
}

async function loadOrphans() {
  orphansResults.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const json = await fetchJson("/api/orphans?limit=50");
    const rows = json.rows ?? [];
    if (!rows.length) {
      orphansResults.innerHTML = '<p class="hint">No orphan notes.</p>';
      return;
    }
    orphansResults.innerHTML = "";
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "hit";
      el.innerHTML = `
        <div class="title">${escape(row.title)}</div>
        <div class="path">${escape(row.path)}</div>
        <div class="meta">${escape([row.type, row.area, row.status, row.updated].filter(Boolean).join(" · "))}</div>
      `;
      el.addEventListener("click", () => openNote(row.path, { targetPane: orphansDetail }));
      orphansResults.appendChild(el);
    }
  } catch (err) {
    orphansResults.innerHTML = `<div class="error">${escape(err.message)}</div>`;
  }
}

async function loadDeadLinks() {
  deadLinksResults.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const json = await fetchJson("/api/dead-links?limit=50");
    const rows = json.rows ?? [];
    if (!rows.length) {
      deadLinksResults.innerHTML = '<p class="hint">No dead links.</p>';
      return;
    }
    deadLinksResults.innerHTML = "";
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "hit";
      const brokenList = row.broken.map((r) => `[[${escape(r)}]]`).join(", ");
      el.innerHTML = `
        <div class="title">${escape(row.title)}</div>
        <div class="path">${escape(row.path)}</div>
        <div class="meta broken">${brokenList}</div>
      `;
      el.addEventListener("click", () => openNote(row.path, { targetPane: deadLinksDetail }));
      deadLinksResults.appendChild(el);
    }
  } catch (err) {
    deadLinksResults.innerHTML = `<div class="error">${escape(err.message)}</div>`;
  }
}

async function openNote(p, { targetPane } = {}) {
  const pane = targetPane ?? detail;
  activePath = p;
  document.body.classList.add("note-open");
  for (const el of results.querySelectorAll(".hit")) {
    el.classList.toggle("active", el.querySelector(".path")?.textContent === p);
  }
  pane.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const note = await fetchJson(`/api/read?path=${encodeURIComponent(p)}`);
    const outlinks = (note.outlinks ?? [])
      .map((o) => o.unresolved
        ? `<li class="unresolved">[[${escape(o.raw)}]]</li>`
        : `<li><a data-path="${escape(o.path)}">${escape(o.title ?? o.path)}</a></li>`)
      .join("") || '<li class="unresolved">none</li>';

    pane.innerHTML = `
      <button class="back-to-results" type="button" aria-label="Back to results">←</button>
      <h2>${escape(note.title)}</h2>
      <div class="path">${escape(note.path)}${note.truncated ? ` · truncated at ${note.maxChars}` : ""}</div>
      <div class="links">
        <div><h3>Outlinks (${(note.outlinks ?? []).length})</h3><ul>${outlinks}</ul></div>
      </div>
      <pre class="body"></pre>
    `;
    pane.querySelector("pre.body").textContent = note.rawContent;
    pane.querySelectorAll("a[data-path]").forEach((a) => {
      a.addEventListener("click", (e) => { e.preventDefault(); openNote(a.dataset.path, { targetPane }); });
    });
    pane.querySelector(".back-to-results")?.addEventListener("click", () => {
      activePath = null;
      document.body.classList.remove("note-open");
      for (const el of results.querySelectorAll(".hit")) el.classList.remove("active");
    });
    renderBacklinks(note);
    loadSuggestions(p);
    loadRelated(p);
  } catch (err) {
    pane.innerHTML = `
      <button class="back-to-results" type="button" aria-label="Back to results">←</button>
      <div class="error">${escape(err.message)}</div>
    `;
    pane.querySelector(".back-to-results")?.addEventListener("click", () => {
      activePath = null;
      document.body.classList.remove("note-open");
      for (const el of results.querySelectorAll(".hit")) el.classList.remove("active");
    });
  }
}

qInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

for (const btn of viewNav.querySelectorAll(".view-tab")) {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
}

loadStats();
setInterval(loadStats, 5000);
loadIdentity();

/* GRAPH */
const FOLDER_COLORS = {
  "00": "#c4b5fd", "01": "#fdba74", "02": "#fcd34d", "03": "#f9a8d4",
  "10": "#fde047", "20": "#7dd3fc", "30": "#fca5a5", "40": "#6ee7b7",
  "50": "#67e8f9", "60": "#f0abfc", "70": "#d6d3d1", "80": "#cbd5e1",
  "90": "#d8b4fe", "95": "#c4b5fd",
};

function folderColor(folder) {
  const m = /^(\d\d)\s/.exec(folder || "");
  if (m && FOLDER_COLORS[m[1]]) return FOLDER_COLORS[m[1]];
  return getComputedStyle(document.documentElement).getPropertyValue("--text-3").trim() || "#9aa3b2";
}

async function loadGraph() {
  if (graphLoaded) return;
  if (typeof ForceGraph !== "function") {
    graphCanvas.innerHTML = '<div class="graph-empty">force-graph library missing.</div>';
    return;
  }
  graphCanvas.innerHTML = '<div class="graph-empty">Loading graph…</div>';
  try {
    const data = await fetchJson("/api/graph");
    if (!data.nodes.length) {
      graphCanvas.innerHTML = '<div class="graph-empty">No notes indexed yet.</div>';
      return;
    }
    graphCanvas.innerHTML = "";
    graphInstance = ForceGraph()(graphCanvas)
      .graphData(data)
      .nodeId("id")
      .nodeLabel((n) => n.title)
      .nodeVal((n) => 1 + (n.backlinkCount ?? 0) * 0.6)
      .nodeColor((n) => folderColor(n.folder))
      .linkColor(() => getComputedStyle(document.documentElement).getPropertyValue("--border-2").trim() || "#a8a29e")
      .linkDirectionalParticles(0)
      .backgroundColor(getComputedStyle(document.documentElement).getPropertyValue("--bg-1").trim() || "#fafaf9")
      .onNodeClick((node) => {
        switchView("search");
        openNote(node.id);
      });
    graphLoaded = true;
    const fitGraph = () => graphInstance?.width(graphCanvas.clientWidth).height(graphCanvas.clientHeight);
    requestAnimationFrame(fitGraph);
    const resizeObserver = new ResizeObserver(fitGraph);
    resizeObserver.observe(graphCanvas);
  } catch (err) {
    graphCanvas.innerHTML = `<div class="error">Graph load failed: ${escape(err.message)}</div>`;
  }
}
