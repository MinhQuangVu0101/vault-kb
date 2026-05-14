const $ = (id) => document.getElementById(id);
const results = $("results");
const detail = $("detail");
const statsBar = $("stats-bar");
const qInput = $("q");
const modeSelect = $("mode");
const folderInput = $("folder");
const tagInput = $("tag");
const goBtn = $("go");
const backlinksList = $("backlinks-list");
const suggestList = $("suggest-list");
const identityBadge = $("identity-badge");
const viewNav = $("view-nav");
const orphansResults = $("orphans-results");
const orphansDetail = $("orphans-detail");
const deadLinksResults = $("dead-links-results");
const deadLinksDetail = $("dead-links-detail");

let activePath = null;
let activeView = "search";

function switchView(name) {
  if (!["search", "orphans", "dead-links"].includes(name)) return;
  activeView = name;
  for (const btn of viewNav.querySelectorAll(".view-tab")) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  for (const section of document.querySelectorAll("#content-pane .view")) {
    section.classList.toggle("hidden", section.id !== `view-${name}`);
  }
  if (name === "orphans") loadOrphans();
  else if (name === "dead-links") loadDeadLinks();
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
    const parts = [
      `indexed: ${s.indexed}`,
      `embeddings: ${s.embeddings.covered}/${s.embeddings.total}`,
      `watcher: ${s.watcher?.active ? "on" : "off"}`,
      `lastIngest: ${s.lastIngest ? new Date(s.lastIngest).toLocaleTimeString() : "-"}`,
    ];
    if (s.embeddings.reachable === false) parts.push("ollama: unreachable");
    statsBar.textContent = parts.join(" · ");
  } catch (err) {
    statsBar.textContent = `stats error: ${err.message}`;
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
  const mode = modeSelect.value;
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

goBtn.addEventListener("click", doSearch);
qInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

for (const btn of viewNav.querySelectorAll(".view-tab")) {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
}

loadStats();
setInterval(loadStats, 5000);
loadIdentity();
