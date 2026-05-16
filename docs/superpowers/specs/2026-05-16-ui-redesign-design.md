# Vault-KB Web UI — Redesign (Phase 3.1)

**Status:** Draft
**Date:** 2026-05-16
**Owner:** Minh Quang Vu

## Goal

Make the local web UI both **daily-use-friendly** AND **showcase-ready** (for `npm publish` discoverability and README screenshots). Add a vault-wide Graph view inspired by Obsidian's graph.

The current UI is functional but visually rough — fine for solo dev use, not pitch-ready. This redesign keeps the 3-column structure (familiar) but polishes every surface and adds one new view.

## Foundation decisions (brainstormed 2026-05-16)

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Primary goal | Daily-use friendliness **and** OSS showcase | Atelier-strict consistency, Vacation-Tracker glassmorphism |
| Layout | Current 3-col (nav · main · connections), polished | Search-first w/ bottom-tabs; card-grid + drawer |
| New view | Vault-wide Graph as own tab | Local ego-net inline; modal overlay |
| Color mode | Light + Dark with toggle, default = `prefers-color-scheme` | Dark only; light only |
| Design language | Atelier-inspired (Stone warm-neutrals, iOS Green, Inter, no shadows, 10-14px radius) | Cool slate; multi-accent rainbow |

## Scope

### In
- Rewrite of `public/index.html`, `public/style.css`, `public/app.js`
- New backend endpoint: `GET /api/graph`
- New view: Graph (vault-wide force-directed)
- Theme toggle component + tokens for both modes
- Light vendoring of one graph library (`public/lib/force-graph.min.js`, ~80 KB MIT)

### Out
- Bulk-edit-from-UI (explicit no — keep on MCP tool + CLI)
- Server-side rendering or build step (stays vanilla / no bundler)
- WebSocket real-time updates (5s polling already works)
- Inline ego-net graph in detail pane (defer to Phase 3.2)
- Modal vault-wide graph (redundant once Graph is its own tab)
- New search algorithms or backend behavior changes

## Architecture

Single static SPA, no build step. Vanilla JS, ESM-light, `fetch` for API.

```
public/
├── index.html            # rewritten — 3-col grid, view tabs, theme toggle
├── style.css             # rewritten — token-driven, both modes
├── app.js                # rewritten — view router, theme persistence, graph init
└── lib/
    └── force-graph.min.js  # NEW — vendored Vasturiano force-graph
```

Backend additions in `src/web.js`:
- Add `/api/graph` handler — returns `{nodes, links}` from existing `links` + `notes` tables.
- Existing endpoints (`/api/stats`, `/api/search`, `/api/semantic`, `/api/list`, `/api/read`) unchanged.

## Components

### Header
- Logo: 22px rounded-square with gradient (iOS Green) + "kb" wordmark
- Brand: "vault-kb" (Inter 600, 14px)
- Stat pills: `481 notes` · `2,258 links` (tabular-nums)
- Last-sync timestamp (small, muted)
- Theme toggle (sun/moon icon, 32px hit target)

### Left Nav (96px wide)
- Vertical tabs: Search · **Graph** (new) · Orphans · Dead Links
- Active tab: iOS-Green border + subtle green wash (`bg-2` shifted toward accent)
- Hover: `bg-2` background

### Search Area
- Prominent search input: 10px radius, 1.5px iOS-Green border, larger font (14px medium)
- Mode switch: keyword / semantic as **segment control** (replaces current dropdown)
- Filter chips: `all folders` / `60 Projects` / `+ tag` — interactive, pre-built from top-N folders, persist in URL query string

### Results List (270px wide)
- Card-style hits: title (semibold), meta row (folder · backlinks · primary-tag), 1-line excerpt on hover/active
- Active hit: green border + subtle wash (matches active-tab pattern — consistency)
- Empty state: friendly hint, not just blank

### Detail Pane
- Title: Inter 700, 18px, tight letter-spacing
- Path: ui-monospace, 11px, muted
- Body: 12.5px, 1.6 line-height
- (Phase 3.2 future: inline 2-hop graph inset)

### Connections Sidebar (260px wide)
- Background: `bg-2` (distinguishes from main without using a hard border)
- Three sections: Backlinks · Related · Suggested
- Each item: link-style, hover background
- Section headings: 10px uppercase, 0.08em letter-spacing, muted

### Graph View (NEW)
- Vault-wide force-directed layout via `force-graph` (canvas, 60fps at our scale)
- Node = note; size by `backlinkCount`; color by folder. Folder color = Atelier rainbow when folder name matches `^\d\d ` prefix (e.g. `60 Projects`); else neutral `--text-3`.
- Edge = resolved wikilink (from existing `links` table)
- Click node → open detail in slide-in drawer (no full nav-away, preserves graph state)
- Filter row: folder dropdown · tag dropdown · text-search-within-graph
- Mouse: pan + zoom; double-click node = zoom to fit subgraph
- Performance budget: 481 nodes / 2258 edges = OK; if > 1000 nodes ever, reduce initial render and lazy-load on filter

## Data flow

```
Browser app.js
  ├─ on load          → GET /api/stats (existing)
  │                   → GET /api/identity (existing)
  │                   → render header
  ├─ on search        → GET /api/search?q=... or /api/semantic?q=...
  │                   → render results
  ├─ on result click  → GET /api/read?path=...
  │                   → render detail + connections
  ├─ on Graph tab     → GET /api/graph (NEW)
  │                   → init force-graph instance with nodes/links
  │                   → re-init only on watcher-poll-delta (not on every tab switch)
  └─ on theme toggle  → write localStorage("theme")
                      → toggle `.theme-dark` on <html>
```

## `/api/graph` response shape

```json
{
  "nodes": [
    {
      "id": "60 Projects/Vault KB/Vault KB.md",
      "title": "Vault KB",
      "folder": "60 Projects",
      "backlinkCount": 9,
      "tags": ["mcp", "ai"]
    }
  ],
  "links": [
    {
      "source": "60 Projects/Vault KB/Vault KB.md",
      "target": "60 Projects/Vault KB/Architecture.md"
    }
  ]
}
```

- Only `unresolved: false` edges. Dead-links surface in their own view.
- Includes all `ai-access: true` notes (not filtered) — client filters via UI.
- Cached on server, cache invalidated on watcher `add`/`change`/`unlink` events.

## Color tokens

```css
:root.theme-light {
  --bg-1: #fafaf9;   /* page */
  --bg-2: #f5f5f4;   /* card, sidebar */
  --bg-3: #e7e5e4;   /* hover, modal */
  --border-1: #e7e5e4;
  --border-2: #a8a29e;
  --text-1: #1c1917;
  --text-2: #44403c;
  --text-3: #78716c;
  --accent: #34c759;
  --accent-hover: #2fb350;
  --accent-subtle: #e4f9ea;
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
  --accent: #34c759;          /* same accent in both modes */
  --accent-hover: #2fb350;
  --accent-subtle: #1f3a26;
}
```

Folder-rainbow colors (for Graph node coloring) mirror the Atelier set in `00 System/DESIGN.md`.

## Typography

- **Font:** Inter Variable. Default = Google Fonts CDN (with `display=swap` + browser cache). User can swap by editing one `@import`.
- **Stack fallback:** `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`
- **Sizes:** 18 / 14 / 13 / 12 / 11
- **Weights:** 400 / 500 / 600 / 700
- **`font-variant-numeric: tabular-nums`** on stat pills and counts

Note: This is one external dep (Google Fonts) — slight deviation from the "nothing leaves your machine" story. Acceptable because: (a) fonts cache after first request, (b) CDN call is for static asset not user data, (c) can be vendored later if community asks.

## Spacing & radius

- Base unit: 4px; common: 8 / 12 / 14 / 18 / 24
- Border-radius: `6 / 8 / 10 / 14 / 999`
- No `box-shadow`. Hierarchy via `--bg-1 → --bg-2 → --bg-3` surface shifts.

## Motion

- Theme toggle: 150ms ease-out color/background interpolation
- Tab switch: 200ms ease-out for content opacity
- Graph: native force-graph physics (no overrides)
- Nothing decorative. No parallax, no on-scroll animation.

## Error handling

- API failures → existing error.json pattern preserved. Render as inline `.error` block (already in current CSS).
- Graph: if `/api/graph` fails, show empty-state with retry button. Force-graph itself is fault-tolerant (empty data = empty canvas, no crash).
- Theme: `localStorage` write failure (private/incognito) → silently fall back to system preference. No user-visible error.

## Testing

- `test/web.test.js`: add test for `/api/graph` response shape and basic content (uses fixture vault from existing test setup).
- `test/web.test.js`: add test for empty-vault graph (returns `{nodes: [], links: []}` not 500).
- Manual: theme toggle in both modes, theme-persistence across reload, graph render with 481 nodes (use dev vault).

## Migration

- Backward-compatible. Existing users: same `--web` flag, same endpoints (additive only).
- Public files are static — clearing browser cache shows the new UI immediately after upgrade.
- No DB schema changes required (uses existing `notes` and `links` tables).

## Implementation order (preview for plan)

1. Backend: `GET /api/graph` endpoint + test
2. Token system + theme toggle scaffolding (CSS only, JS toggle, no layout change yet)
3. Header refresh: logo, brand, stat pills, theme toggle
4. Search-area polish: prominent input, segment switch, chip filters
5. Results + Detail polish: card style, active states
6. Connections sidebar: bg-2 background, refined typography
7. Vendor `force-graph.min.js` + new Graph tab
8. Polish pass: spacing audit, dark-mode contrast pass, screenshot for README

## Open questions (deferred decisions)

- **Default tab on first visit:** Search (don't change muscle memory). Reconsider after 1 week.
- **Folder-rainbow in Graph:** start enabled with Atelier colors; provide `--graph-color: folder | tag | uniform` config toggle if it gets noisy.
- **Suggested-Links LLM:** keep `llama3.2:3b` reasoning behind `--no-llm-summary` flag. Unchanged from current behavior.

## References

- `00 System/DESIGN.md` — Atelier design system (source of color/type/spacing decisions)
- `40 Freelance/Projects/Internship/Vacation Tracker/Vacation Tracker — UI Elevation.md` — sibling project, parallel design vocabulary
- `60 Projects/Vault KB/Phases/Phase 2 — Features.md` — what the UI currently does
- [force-graph by Vasturiano](https://github.com/vasturiano/force-graph) — chosen graph lib
