# Vault-KB Web UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the redesigned Light+Dark vault-kb web UI with a vault-wide Graph view as described in `docs/superpowers/specs/2026-05-16-ui-redesign-design.md`.

**Architecture:** Backend gets one new endpoint (`/api/graph`) and one new VaultIndex helper, both test-first. Frontend is rewritten in three layers — token-driven CSS, restructured HTML, refactored JS — verified in the browser preview after each layer. force-graph library is vendored locally. No build step, no new runtime deps.

**Tech Stack:** Vanilla JS / ESM-light, Node `http`, `better-sqlite3`, `node:test`, `force-graph` (Vasturiano) vendored.

---

## File Structure

**New files:**
- `public/lib/force-graph.min.js` — vendored canvas force-graph library (~80 kB, MIT)
- `public/lib/force-graph.LICENSE` — upstream license file copied verbatim

**Rewritten:**
- `public/index.html` — new 3-col grid with header/nav/search/results/detail/connections structure
- `public/style.css` — full rewrite, token-driven, both themes
- `public/app.js` — refactored: theme toggle, view router (now includes Graph), stat pills, filter chips

**Modified:**
- `src/vault-index.js` — add `getGraphData()` method (~25 LOC)
- `src/web.js` — add `case "/api/graph"` route (~6 LOC inside the existing switch)
- `test/web.test.js` — add `/api/graph` tests
- `README.md` — add screenshot section, update CLI help table if needed
- `package.json` — bump version to `0.2.0`

**Unchanged:**
- All other `src/*.js` (config, embeddings, links, logger, stats, suggest-links, related, watcher, smoke-test)
- All other tests
- `vault-ai.config.json` (gitignored, user-local)

---

## Task 1: Add `getGraphData()` to VaultIndex (TDD)

**Files:**
- Modify: `src/vault-index.js` — append new method after `findDeadLinks` (around line 633)
- Modify: `test/web.test.js` — append after the last existing test
- Modify: `src/web.js` — add route handler inside the switch (around line 217, before `/api/identity`)

- [ ] **Step 1: Write failing test for /api/graph response shape**

Append at end of `test/web.test.js`:

```javascript
test("GET /api/graph returns nodes and links arrays", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/graph`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.nodes), "nodes is array");
    assert.ok(Array.isArray(json.links), "links is array");
    // fixture has a.md and b.md, with a linking to b
    const nodeIds = new Set(json.nodes.map((n) => n.id));
    assert.ok(nodeIds.has("a.md"), "a.md is a node");
    assert.ok(nodeIds.has("b.md"), "b.md is a node");
    // node shape
    const a = json.nodes.find((n) => n.id === "a.md");
    assert.equal(typeof a.title, "string");
    assert.equal(typeof a.folder, "string");
    assert.equal(typeof a.backlinkCount, "number");
    assert.ok(Array.isArray(a.tags));
    // resolved link a → b exists
    const linkAB = json.links.find((l) => l.source === "a.md" && l.target === "b.md");
    assert.ok(linkAB, "resolved link a.md → b.md");
  });
});

test("GET /api/graph on empty vault returns empty arrays", async () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), "vault-kb-web-empty-"));
  const config = mkConfig(v);
  const index = new VaultIndex(config);
  index.ingest();
  const web = createWebServer({
    vaultIndex: index,
    statsSource: () => ({ indexed: 0, watcher: { active: false, events: null }, embeddings: { covered: 0, total: 0, reachable: null, model: null, lastError: null }, lastIngest: null }),
    host: "127.0.0.1",
    port: 0,
  });
  const info = await web.start();
  try {
    const res = await fetch(`http://${info.host}:${info.port}/api/graph`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { nodes: [], links: [] });
  } finally {
    await web.stop();
    index.close();
  }
});
```

- [ ] **Step 2: Run tests, expect both to FAIL**

Run from `C:/Users/qang/Documents/GitHub/vault-kb`:

```bash
node --test test/web.test.js
```

Expected: 2 failures (`404 unknown endpoint` on both new tests).

- [ ] **Step 3: Add `getGraphData()` method to VaultIndex**

Append in `src/vault-index.js` after `findDeadLinks` closing brace (around line 633):

```javascript
  getGraphData() {
    const noteRows = this.db.prepare(`
      SELECT path, title, folder, tags_text
      FROM notes
      ORDER BY path
    `).all();

    const linkRows = this.db.prepare(`
      SELECT source, target
      FROM links
      WHERE unresolved = 0 AND target IS NOT NULL
      ORDER BY source, target
    `).all();

    const counts = this.backlinkCounts();
    const nodes = noteRows.map((row) => ({
      id: row.path,
      title: row.title ?? row.path,
      folder: row.folder ?? "",
      backlinkCount: counts.get(row.path) ?? 0,
      tags: row.tags_text
        ? row.tags_text.split(/\s+/).filter(Boolean)
        : [],
    }));

    const links = linkRows.map((row) => ({
      source: row.source,
      target: row.target,
    }));

    return { nodes, links };
  }
```

- [ ] **Step 4: Add `/api/graph` route to web.js**

In `src/web.js`, inside the `switch (url.pathname)` block, add a new case BEFORE `case "/api/identity"` (currently around line 218):

```javascript
        case "/api/graph": {
          try {
            return sendJson(res, 200, vaultIndex.getGraphData());
          } catch (err) {
            return sendError(res, 500, String(err?.message ?? err));
          }
        }
```

- [ ] **Step 5: Run tests, expect PASS**

```bash
node --test test/web.test.js
```

Expected: all tests pass including the 2 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/vault-index.js src/web.js test/web.test.js
git commit -m "feat(api): add GET /api/graph endpoint

Returns {nodes, links} for vault-wide force-directed graph rendering.
- nodes: id, title, folder, backlinkCount, tags
- links: source, target (resolved only; unresolved excluded)
- Empty vault returns {nodes: [], links: []}"
```

---

## Task 2: Vendor force-graph library

**Files:**
- Create: `public/lib/force-graph.min.js`
- Create: `public/lib/force-graph.LICENSE`

- [ ] **Step 1: Download force-graph v1.43.5 (pinned)**

```bash
mkdir -p public/lib
curl -sL "https://unpkg.com/force-graph@1.43.5/dist/force-graph.min.js" -o public/lib/force-graph.min.js
curl -sL "https://raw.githubusercontent.com/vasturiano/force-graph/v1.43.5/LICENSE" -o public/lib/force-graph.LICENSE
```

- [ ] **Step 2: Sanity-check file**

```bash
wc -c public/lib/force-graph.min.js
head -c 200 public/lib/force-graph.min.js
```

Expected: file size between 60kB and 120kB. First chars look like minified JS (no HTML 404 page).

- [ ] **Step 3: Commit**

```bash
git add public/lib/force-graph.min.js public/lib/force-graph.LICENSE
git commit -m "vendor: force-graph@1.43.5 for vault-wide Graph view

MIT licensed (LICENSE file copied verbatim). Pinned to v1.43.5 so the
vendored bundle is reproducible. Loaded only when the Graph tab opens."
```

---

## Task 3: Rewrite `public/style.css` with token system + both themes

**Files:**
- Rewrite: `public/style.css`

This task is one big rewrite because the existing CSS uses one root token set and dark-only colors. We replace it wholesale rather than diffing.

- [ ] **Step 1: Write the new stylesheet**

Replace the entire contents of `public/style.css` with:

```css
/* vault-kb — token-driven UI, light + dark */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

*, *::before, *::after { box-sizing: border-box; }

:root {
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 14px;
  --radius-pill: 999px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 14px; --sp-5: 18px; --sp-6: 24px;
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

:root, :root.theme-light {
  --bg-1: #fafaf9;
  --bg-2: #f5f5f4;
  --bg-3: #e7e5e4;
  --border-1: #e7e5e4;
  --border-2: #a8a29e;
  --text-1: #1c1917;
  --text-2: #44403c;
  --text-3: #78716c;
  --accent: #34c759;
  --accent-hover: #2fb350;
  --accent-subtle: #e4f9ea;
  --danger: #dc2626;
  --shadow-overlay: 0 8px 32px rgba(0, 0, 0, 0.12);
}

:root.theme-dark {
  --bg-1: #0f1115;
  --bg-2: #171a21;
  --bg-3: #1f2330;
  --border-1: #2a2f3a;
  --border-2: #3a4051;
  --text-1: #e6e9ef;
  --text-2: #c5cad4;
  --text-3: #9aa3b2;
  --accent: #34c759;
  --accent-hover: #2fb350;
  --accent-subtle: #1f3a26;
  --danger: #f87171;
  --shadow-overlay: 0 8px 32px rgba(0, 0, 0, 0.55);
}

html, body { margin: 0; height: 100%; }
body {
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-1);
  background: var(--bg-1);
  -webkit-font-smoothing: antialiased;
  display: flex;
  flex-direction: column;
}

/* HEADER */
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-5);
  border-bottom: 1px solid var(--border-1);
  background: var(--bg-1);
  gap: var(--sp-4);
}
.brand-block { display: flex; align-items: center; gap: var(--sp-3); }
.logo {
  width: 22px; height: 22px;
  border-radius: 7px;
  background: linear-gradient(135deg, var(--accent), var(--accent-hover));
  display: grid; place-items: center;
  color: #ffffff;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: -0.02em;
}
.brand { font-weight: 600; font-size: 14px; letter-spacing: -0.01em; }
.stat-pills { display: flex; gap: var(--sp-2); }
.pill {
  font-size: 11px;
  font-weight: 500;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-1);
  background: var(--bg-2);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.pill .dot {
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--accent);
  margin-right: 5px;
  vertical-align: middle;
}
.pill.warn .dot { background: var(--danger); }
.header-right { display: flex; align-items: center; gap: var(--sp-3); }
.last-sync { font-size: 11px; color: var(--text-3); }
.theme-toggle {
  width: 32px; height: 32px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-1);
  background: var(--bg-2);
  color: var(--text-1);
  cursor: pointer;
  display: grid; place-items: center;
  font-size: 14px;
  transition: background 150ms ease-out, border-color 150ms ease-out;
}
.theme-toggle:hover { border-color: var(--border-2); }

/* MAIN GRID */
main {
  flex: 1;
  display: grid;
  grid-template-columns: 96px 1fr 260px;
  min-height: 0;
}

/* LEFT NAV */
#view-nav {
  border-right: 1px solid var(--border-1);
  padding: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.view-tab {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-2);
  padding: 7px 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out;
}
.view-tab:hover { background: var(--bg-2); }
.view-tab.active {
  background: var(--accent-subtle);
  color: var(--text-1);
  border-color: var(--accent);
}

/* CENTER CONTENT */
#content-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.view { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.view.hidden { display: none; }
.view-header { padding: var(--sp-3) var(--sp-5); border-bottom: 1px solid var(--border-1); }
.view-header h2 { margin: 0 0 var(--sp-1); font-size: 16px; font-weight: 600; }
.view-header .hint { font-size: 12px; color: var(--text-3); }

/* SEARCH AREA */
.search {
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--border-1);
}
.search-row { display: flex; gap: var(--sp-2); align-items: stretch; }
.search-input {
  flex: 1;
  background: var(--bg-1);
  color: var(--text-1);
  border: 1.5px solid var(--accent);
  border-radius: var(--radius-lg);
  padding: 10px 14px;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
}
.search-input:focus { outline: none; border-color: var(--accent-hover); }
.mode-switch {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-1);
  background: var(--bg-2);
  align-items: center;
  font-size: 11px;
  font-weight: 500;
}
.mode-switch button {
  background: transparent;
  border: none;
  padding: 5px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font: inherit;
  color: var(--text-2);
}
.mode-switch button.on { background: var(--accent); color: #0b1016; }
.filter-row { display: flex; gap: var(--sp-2); margin-top: var(--sp-2); flex-wrap: wrap; }
.chip {
  background: var(--bg-2);
  border: 1px solid var(--border-1);
  color: var(--text-3);
  border-radius: var(--radius-pill);
  padding: 4px 10px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.chip.on { background: var(--text-1); color: var(--bg-1); border-color: var(--text-1); }
.chip input {
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  font-size: 11px;
  outline: none;
  width: 100px;
}

/* RESULTS + DETAIL (two-pane) */
.two-pane { flex: 1; display: grid; grid-template-columns: 270px 1fr; min-height: 0; }
.pane-list, .pane-detail { overflow-y: auto; padding: var(--sp-3) var(--sp-4); }
.pane-list { border-right: 1px solid var(--border-1); }

.hit {
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  margin-bottom: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 150ms ease-out, border-color 150ms ease-out;
}
.hit:hover { background: var(--bg-2); border-color: var(--border-1); }
.hit.active { background: var(--accent-subtle); border-color: var(--accent); }
.hit-title { font-weight: 600; font-size: 13px; letter-spacing: -0.005em; margin-bottom: 3px; }
.hit-meta { font-size: 11px; color: var(--text-3); display: flex; gap: 6px; flex-wrap: wrap; }
.hit-meta .sep { opacity: 0.5; }
.hit-excerpt { font-size: 11.5px; color: var(--text-3); margin-top: 5px; line-height: 1.5; }

.pane-detail h2 { margin: 10px 0 4px; font-size: 18px; font-weight: 700; letter-spacing: -0.015em; }
.pane-detail .path { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-bottom: var(--sp-4); }
.pane-detail .links { margin: var(--sp-4) 0; }
.pane-detail .links h3 { margin: 0 0 var(--sp-1); font-size: 10px; text-transform: uppercase; color: var(--text-3); letter-spacing: 0.08em; }
.pane-detail .links ul { list-style: none; padding: 0; margin: 0; font-size: 12px; }
.pane-detail .links li { padding: 3px 0; }
.pane-detail .links a { color: var(--accent); text-decoration: none; cursor: pointer; }
.pane-detail .links a:hover { text-decoration: underline; }
.pane-detail .links .unresolved { color: var(--text-3); font-style: italic; }
.pane-detail pre.body {
  background: var(--bg-2);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-1);
  white-space: pre-wrap;
  font: 12px/1.55 var(--font-mono);
  overflow-x: auto;
}

/* CONNECTIONS SIDEBAR */
#connections {
  background: var(--bg-2);
  border-left: 1px solid var(--border-1);
  overflow-y: auto;
  padding: var(--sp-4) var(--sp-4) var(--sp-6);
}
#connections h3 {
  margin: var(--sp-4) 0 var(--sp-1);
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-3);
  letter-spacing: 0.08em;
  font-weight: 700;
}
#connections section:first-of-type h3 { margin-top: var(--sp-1); }
#connections ul { list-style: none; padding: 0; margin: 0; font-size: 12px; }
#connections li { padding: 4px 0; line-height: 1.4; }
#connections li.suggestion { padding: 8px 0; border-bottom: 1px solid var(--border-1); }
#connections li.suggestion:last-child { border-bottom: none; }
#connections .title-row { display: flex; align-items: baseline; gap: 6px; }
#connections .title-row a { color: var(--text-1); text-decoration: none; cursor: pointer; font-weight: 500; }
#connections .title-row a:hover { color: var(--accent); }
#connections .reason { color: var(--text-3); font-size: 11px; margin-top: 3px; line-height: 1.4; }
#connections li.error { color: var(--danger); padding: 4px 0; }

/* GRAPH VIEW */
#view-graph .view-header { display: flex; justify-content: space-between; align-items: center; }
#graph-canvas {
  flex: 1;
  position: relative;
  background: var(--bg-1);
  min-height: 0;
}
#graph-canvas .graph-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-3);
  font-size: 12px;
}

/* MISC */
.hint { color: var(--text-3); font-size: 12px; padding: var(--sp-2) var(--sp-3); }
.error { color: var(--danger); padding: var(--sp-2) var(--sp-3); background: color-mix(in srgb, var(--danger) 10%, transparent); border-radius: var(--radius-md); }
.badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  border: 1px solid var(--border-1);
  font-size: 11px;
  margin-left: 6px;
  color: var(--text-3);
}
.identity-badge { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 12px; }
.identity-badge.hidden { display: none; }
.identity-badge .email { font-family: var(--font-mono); }
.identity-badge a { color: var(--accent); text-decoration: none; }
.identity-badge a:hover { text-decoration: underline; }

/* RESPONSIVE */
@media (max-width: 1100px) {
  main { grid-template-columns: 96px 1fr; }
  #connections { display: none; }
}
@media (max-width: 600px) {
  main { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  #view-nav { flex-direction: row; border-right: none; border-bottom: 1px solid var(--border-1); padding: var(--sp-2); overflow-x: auto; }
  .view-tab { white-space: nowrap; }
  .two-pane { grid-template-columns: 1fr; }
  body:not(.note-open) .pane-detail { display: none; }
  body.note-open .pane-list { display: none; }
  .pane-list { border-right: none; }
}
.back-to-results {
  display: none;
  background: var(--bg-2);
  color: var(--text-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  padding: 4px 10px;
  font: inherit;
  cursor: pointer;
  margin-bottom: var(--sp-2);
}
.back-to-results:hover { background: var(--bg-3); }
@media (max-width: 600px) { .back-to-results { display: inline-flex; align-items: center; } }
```

- [ ] **Step 2: Commit (HTML/JS update next; verification deferred until they land)**

```bash
git add public/style.css
git commit -m "style: token-driven CSS with light + dark themes

- :root theme tokens (Stone neutrals, iOS Green accent)
- :root.theme-dark inverts neutrals, keeps accent
- New: header pills, theme toggle, segment switch, filter chips
- Connections sidebar gets bg-2 surface
- No box-shadows (Atelier pattern)
- Existing classes (.hit, .pane-detail) re-styled but selectors unchanged
- Graph view wrapper styled (#graph-canvas, #view-graph)"
```

---

## Task 4: Rewrite `public/index.html`

**Files:**
- Rewrite: `public/index.html`

- [ ] **Step 1: Replace HTML contents**

Replace the entire contents of `public/index.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>vault-kb</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <div class="brand-block">
      <div class="logo">kb</div>
      <span class="brand">vault-kb</span>
      <div id="stat-pills" class="stat-pills"></div>
    </div>
    <div class="header-right">
      <span id="last-sync" class="last-sync"></span>
      <div id="identity-badge" class="identity-badge hidden"></div>
      <button id="theme-toggle" class="theme-toggle" type="button" title="Toggle theme">🌙</button>
    </div>
  </header>

  <main>
    <nav id="view-nav" aria-label="Views">
      <button class="view-tab active" data-view="search" type="button">Search</button>
      <button class="view-tab" data-view="graph" type="button">Graph</button>
      <button class="view-tab" data-view="orphans" type="button">Orphans</button>
      <button class="view-tab" data-view="dead-links" type="button">Dead Links</button>
    </nav>

    <section id="content-pane">
      <section id="view-search" class="view">
        <section class="search">
          <div class="search-row">
            <input id="q" class="search-input" type="search" placeholder="Search vault…" autofocus>
            <div id="mode-switch" class="mode-switch">
              <button type="button" class="on" data-mode="search">keyword</button>
              <button type="button" data-mode="semantic">semantic</button>
            </div>
          </div>
          <div class="filter-row">
            <button class="chip on" id="chip-all" type="button" data-clear>all folders</button>
            <label class="chip"><input type="text" id="folder" placeholder="folder…"></label>
            <label class="chip"><input type="text" id="tag" placeholder="tag…"></label>
          </div>
        </section>
        <div class="two-pane">
          <aside id="results" class="pane-list" aria-label="Results"></aside>
          <article id="detail" class="pane-detail" aria-label="Note detail"><p class="hint">Pick a result to see details.</p></article>
        </div>
      </section>

      <section id="view-graph" class="view hidden">
        <div class="view-header"><h2>Graph</h2><p class="hint">All AI-accessible notes and their wikilinks.</p></div>
        <div id="graph-canvas"><div class="graph-empty">Loading…</div></div>
      </section>

      <section id="view-orphans" class="view hidden">
        <div class="view-header"><h2>Orphan notes</h2><p class="hint">Notes with no incoming and no outgoing resolved links.</p></div>
        <div class="two-pane">
          <aside id="orphans-results" class="pane-list" aria-label="Orphans"></aside>
          <article id="orphans-detail" class="pane-detail" aria-label="Orphan note detail"><p class="hint">Pick an orphan to see details.</p></article>
        </div>
      </section>

      <section id="view-dead-links" class="view hidden">
        <div class="view-header"><h2>Dead links</h2><p class="hint">Unresolved <code>[[references]]</code> grouped by source note.</p></div>
        <div class="two-pane">
          <aside id="dead-links-results" class="pane-list" aria-label="Dead links"></aside>
          <article id="dead-links-detail" class="pane-detail" aria-label="Source note detail"><p class="hint">Pick a source to see details.</p></article>
        </div>
      </section>
    </section>

    <aside id="connections" aria-label="Connections">
      <section id="backlinks-panel">
        <h3>Backlinks</h3>
        <ul id="backlinks-list"><li class="hint">—</li></ul>
      </section>
      <section id="related-panel">
        <h3>Related</h3>
        <ul id="related-list"><li class="hint">Pick a note to see related.</li></ul>
      </section>
      <section id="suggest-panel">
        <h3>Suggested Links</h3>
        <ul id="suggest-list"><li class="hint">Pick a note to see suggestions.</li></ul>
      </section>
    </aside>
  </main>

  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "html: restructure header (logo + pills + toggle), add Graph tab

- Header: logo, brand, stat pills, last-sync, identity badge, theme toggle
- Nav: add 'Graph' tab between Search and Orphans
- Search: prominent input, segment-switch buttons (keyword|semantic), chip filters
- Graph view: empty canvas wrapper (#graph-canvas) for force-graph mount
- Existing IDs (#results, #detail, #connections, #backlinks-list, etc.) preserved
  so app.js can still find them"
```

---

## Task 5: Refactor `public/app.js` — theme toggle + stat pills + segment switch

**Files:**
- Modify: `public/app.js` (the existing element-lookup block + stats + search bindings)

This is a focused edit on existing logic, not a rewrite. Graph wiring happens in Task 6.

- [ ] **Step 1: Update element lookups + add theme state**

Replace the top block of `public/app.js` (currently lines 1-21, ending with `let activeView = "search";`) with:

```javascript
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

/* THEME */
const THEME_KEY = "vault-kb-theme";
function applyTheme(theme) {
  document.documentElement.classList.toggle("theme-dark", theme === "dark");
  document.documentElement.classList.toggle("theme-light", theme !== "dark");
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
}
themeToggle?.addEventListener("click", toggleTheme);
initTheme();
```

- [ ] **Step 2: Update `switchView` to include `graph`**

Find the existing `function switchView(name) {` and replace with:

```javascript
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
```

(`loadGraph` is defined in Task 6.)

- [ ] **Step 3: Replace `loadStats` to render pills**

Find the existing `async function loadStats()` and replace with:

```javascript
async function loadStats() {
  try {
    const s = await fetchJson("/api/stats");
    const pills = [
      `<span class="pill"><span class="dot"></span>${s.indexed} notes</span>`,
      `<span class="pill">${s.embeddings.covered}/${s.embeddings.total} embeddings</span>`,
      `<span class="pill ${s.watcher?.active ? "" : "warn"}"><span class="dot"></span>watcher ${s.watcher?.active ? "on" : "off"}</span>`,
    ];
    if (s.embeddings.reachable === false) {
      pills.push(`<span class="pill warn"><span class="dot"></span>ollama unreachable</span>`);
    }
    statPills.innerHTML = pills.join("");
    lastSync.textContent = s.lastIngest ? `last sync · ${new Date(s.lastIngest).toLocaleTimeString()}` : "";
  } catch (err) {
    statPills.innerHTML = `<span class="pill warn">stats error</span>`;
    lastSync.textContent = "";
  }
}
```

- [ ] **Step 4: Wire the segment-switch (replaces `modeSelect.value`)**

Find the `async function doSearch()` definition. Replace the line:

```javascript
  const mode = modeSelect.value;
```

with:

```javascript
  const mode = searchMode;
```

Then, immediately after the `themeToggle?.addEventListener("click", toggleTheme);` block (end of theme setup), add:

```javascript
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
```

- [ ] **Step 5: Remove the old `goBtn` and `modeSelect` bindings if present**

Find any remaining references to `goBtn` or `modeSelect` in `app.js` and:

- Remove the `const goBtn = $("go");` line (and `const modeSelect = $("mode");` if still present) — both elements no longer exist in the HTML.
- Remove the `goBtn.addEventListener("click", doSearch);` line.
- Keep search-on-Enter wiring (`qInput.addEventListener("keydown", …)`) — that still works.

If search-on-Enter wiring is missing, add this near the other event listeners:

```javascript
qInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
```

- [ ] **Step 6: Start preview server and smoke-test**

```bash
node "C:/Users/qang/Documents/GitHub/vault-kb/src/index.js" --web --no-watcher --no-embed --no-llm-summary
```

(Or use the existing `vault-kb-web` entry in `.claude/launch.json` if you're inside Claude Code.)

Open `http://localhost:7345` in a browser. Verify:

- Header shows logo, brand, three pills, last-sync, theme toggle
- Click theme toggle: theme flips, page survives reload (localStorage)
- Type a search term + Enter: results appear in the polished hit cards
- Click `keyword` / `semantic` buttons in the segment switch: switch is reflected by `.on` state, search uses new mode
- Click a result: detail pane fills, connections sidebar shows backlinks/related/suggested
- Click `Orphans` / `Dead Links`: views render (existing endpoints, no regression)
- Console has no errors

If any of the above fails, fix in app.js or style.css before committing.

- [ ] **Step 7: Commit**

```bash
git add public/app.js
git commit -m "js: theme toggle, stat pills, segment search switch

- Theme: applyTheme/toggleTheme with localStorage + prefers-color-scheme
  default; falls back gracefully when storage is denied
- Stats: render as pills (notes / embeddings / watcher), separate
  last-sync line, color-coded warn state
- Search-mode: segment-switch buttons replace native <select>
- Drop unused goBtn, modeSelect; keep Enter-to-search
- switchView now knows 'graph' (handler added in next commit)"
```

---

## Task 6: Wire the Graph view

**Files:**
- Modify: `public/index.html` (add `<script src="/lib/force-graph.min.js">` before `app.js`)
- Modify: `public/app.js` (add `loadGraph` + state)

- [ ] **Step 1: Add force-graph script tag**

In `public/index.html`, find the line `<script src="/app.js"></script>` near the bottom of `<body>` and replace with:

```html
  <script src="/lib/force-graph.min.js"></script>
  <script src="/app.js"></script>
```

- [ ] **Step 2: Add Graph wiring in app.js**

Append at the end of `public/app.js`:

```javascript
/* GRAPH */
let graphInstance = null;
let graphLoaded = false;

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
    window.addEventListener("resize", () => graphInstance?.width(graphCanvas.clientWidth).height(graphCanvas.clientHeight));
  } catch (err) {
    graphCanvas.innerHTML = `<div class="error">Graph load failed: ${escape(err.message)}</div>`;
  }
}
```

- [ ] **Step 3: Smoke-test Graph view in preview**

Restart the preview server (it picks up new HTML/JS without restart, but the launch.json server caches), then in the browser:

1. Click `Graph` tab — canvas appears, nodes render, force-simulation animates
2. Click a node — switches back to Search view, opens that note in the detail pane
3. Toggle theme while on Graph view — background updates (or, if it doesn't re-render immediately, return to Graph and confirm new bg/edge colors next visit)
4. Console: no errors

If Graph doesn't render: open DevTools network tab, confirm `/lib/force-graph.min.js` returns 200 and `/api/graph` returns the expected payload.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat(ui): Graph view powered by vendored force-graph

- New tab: 'Graph' renders all AI-accessible notes
- Node size: 1 + backlinkCount * 0.6
- Node color: Atelier folder-rainbow when folder starts with /^\\d\\d /, else neutral
- Click node: switch to Search view + open detail (preserves muscle memory)
- Empty vault: friendly empty-state, no crash
- Library loaded only when Graph tab is first opened (Task 2 vendored bundle)"
```

---

## Task 7: README screenshot section + version bump

**Files:**
- Modify: `README.md` (insert screenshot section near top, after badges)
- Create: `docs/screenshots/web-ui-light.png`
- Create: `docs/screenshots/web-ui-dark.png`
- Create: `docs/screenshots/web-ui-graph.png`
- Modify: `package.json` (version `0.1.0` → `0.2.0`)

- [ ] **Step 1: Capture three screenshots**

Start the preview server (or reuse the running one). Open `http://localhost:7345` in your local browser. For each shot:

1. **`web-ui-light.png`** — Light theme, Search tab active, with a real search query that returns 3-5 hits, one selected to populate the detail pane and Connections sidebar.
2. **`web-ui-dark.png`** — Same Search state, dark theme.
3. **`web-ui-graph.png`** — Graph tab, force-simulation settled (~5s wait), light theme (more print-friendly for README).

Take screenshots at 1400×900 or larger. Use OS screenshot tool (Win+Shift+S on Windows, Cmd+Shift+4 on Mac).

Save to `docs/screenshots/` in the repo (create the folder).

- [ ] **Step 2: Insert screenshot section into README**

In `README.md`, find the badges block:

```markdown
[![CI](https://github.com/MinhQuangVu0101/vault-kb/actions/workflows/ci.yml/badge.svg)](https://github.com/MinhQuangVu0101/vault-kb/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
```

Immediately AFTER those two lines (still before `## What it does`), add a blank line and:

```markdown
## Screenshots

| Light | Dark |
|---|---|
| ![Search view, light theme](docs/screenshots/web-ui-light.png) | ![Search view, dark theme](docs/screenshots/web-ui-dark.png) |

Graph view shows all opt-in notes and their wikilinks:

![Graph view](docs/screenshots/web-ui-graph.png)
```

- [ ] **Step 3: Bump version in package.json**

In `package.json`, change:

```json
  "version": "0.1.0",
```

to:

```json
  "version": "0.2.0",
```

- [ ] **Step 4: Update the `files` field to include screenshots and `lib/`**

In `package.json`, the existing `files` is:

```json
  "files": [
    "src/",
    "public/",
    "README.md",
    "LICENSE"
  ],
```

`public/` already covers `public/lib/`. Screenshots in `docs/` are NOT shipped in the npm tarball (avoids bloating it) but are visible on GitHub. Leave `files` unchanged.

Sanity-check the tarball contents stayed clean:

```bash
npm pack --dry-run 2>&1 | tail -30
```

Expected: tarball includes `public/lib/force-graph.min.js` and `public/lib/force-graph.LICENSE`, does NOT include `docs/`, `test/`, `scripts/`, or `.superpowers/`.

- [ ] **Step 5: Commit**

```bash
git add README.md package.json docs/screenshots/
git commit -m "docs: screenshots + 0.2.0

- README: Screenshots section with light/dark/graph shots
- package.json: version 0.2.0 (Phase 3.1 UI redesign + Graph view)
- docs/screenshots/ not shipped to npm (files allow-list unchanged)"
```

---

## Task 8: Final test run + push

- [ ] **Step 1: Run full test suite**

```bash
node --test test/*.test.js
```

Expected: all tests pass except the pre-existing Windows logger test (`/proc/readonly` failure). CI runs on Ubuntu so that fails-on-Windows-only test passes there.

- [ ] **Step 2: Push branch**

```bash
git push
```

Expected: the cleanup/publish-ready branch (or whichever branch this work landed on) updates on GitHub.

- [ ] **Step 3: Confirm CI is green**

```bash
gh run watch
```

Or open https://github.com/MinhQuangVu0101/vault-kb/actions in a browser and wait for the workflow on this branch to finish. If it fails, fix and recommit.

- [ ] **Step 4: Update spec / plan status**

Edit `docs/superpowers/specs/2026-05-16-ui-redesign-design.md`: change `**Status:** Draft` to `**Status:** Shipped (v0.2.0)`.

```bash
git add docs/superpowers/specs/2026-05-16-ui-redesign-design.md
git commit -m "docs: mark UI redesign spec as shipped in v0.2.0"
git push
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Plan task(s) |
|---|---|
| `/api/graph` endpoint | Task 1 |
| Vendored force-graph library | Task 2 |
| Color tokens (both themes) | Task 3 |
| Header (logo, brand, pills, toggle) | Task 4 (HTML) + Task 5 (JS) |
| Left nav (incl. new Graph tab) | Task 4 |
| Search area (input, segment switch, chips) | Task 4 + Task 5 |
| Results + Detail polish | Task 3 (CSS) — re-styled, structure unchanged in Task 4 |
| Connections sidebar bg-2 | Task 3 |
| Graph view component | Task 4 (HTML) + Task 6 (JS) |
| Typography (Inter, sizes, weights) | Task 3 |
| Spacing & radius | Task 3 |
| Motion (150/200ms eases) | Task 3 (transitions on tabs/toggle) |
| Error handling | Task 1 (graph 500), Task 5 (graceful localStorage), Task 6 (empty-state) |
| Tests | Task 1 (TDD), Task 8 (full run) |
| Migration (backward-compat) | Implicit — endpoints additive, IDs preserved, no DB change |
| README screenshots | Task 7 |

All spec sections have at least one task.

**Open spec questions, plan stance:**

- "Default tab on first visit": plan defaults to Search (matches existing behavior in `app.js:21` — `activeView = "search"`).
- "Folder-rainbow in Graph": plan enables it (Task 6, `FOLDER_COLORS` map mirroring Atelier).
- "Suggested-Links LLM": no change — plan leaves it as-is.
