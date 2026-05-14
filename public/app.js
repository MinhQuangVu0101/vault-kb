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

let activePath = null;

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

async function openNote(p) {
  activePath = p;
  for (const el of results.querySelectorAll(".hit")) {
    el.classList.toggle("active", el.querySelector(".path")?.textContent === p);
  }
  detail.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const note = await fetchJson(`/api/read?path=${encodeURIComponent(p)}`);
    const outlinks = (note.outlinks ?? [])
      .map((o) => o.unresolved
        ? `<li class="unresolved">[[${escape(o.raw)}]]</li>`
        : `<li><a data-path="${escape(o.path)}">${escape(o.title ?? o.path)}</a></li>`)
      .join("") || '<li class="unresolved">none</li>';

    detail.innerHTML = `
      <h2>${escape(note.title)}</h2>
      <div class="path">${escape(note.path)}${note.truncated ? ` · truncated at ${note.maxChars}` : ""}</div>
      <div class="links">
        <div><h3>Outlinks (${(note.outlinks ?? []).length})</h3><ul>${outlinks}</ul></div>
      </div>
      <pre class="body"></pre>
    `;
    detail.querySelector("pre.body").textContent = note.rawContent;
    detail.querySelectorAll("a[data-path]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openNote(a.dataset.path);
      });
    });
    renderBacklinks(note);
    loadSuggestions(p);
  } catch (err) {
    detail.innerHTML = `<div class="error">${escape(err.message)}</div>`;
  }
}

goBtn.addEventListener("click", doSearch);
qInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

loadStats();
setInterval(loadStats, 5000);
