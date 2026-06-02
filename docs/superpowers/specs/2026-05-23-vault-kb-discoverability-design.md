# vault-kb Discoverability — Design

**Date:** 2026-05-23
**Status:** Draft, pending implementation plan
**Scope:** Add two new MCP tools (`kb_overview`, `kb_tree`) and sharpen tool descriptions so an AI client entering the vault discovers structure on its own, without being told the folder layout.

## Problem

Observed behavior: AI clients connected to vault-kb (Claude Code, Claude Desktop, etc.) do not consult the vault first when working on a topic that exists in the user's notes — even though substantial relevant material is indexed. The agent jumps to other context sources (file system, web, conversation) before calling any `kb_*` tool.

Root cause analysis: the current 11-tool surface is composed of access primitives (`kb_search`, `kb_list`, `kb_read`, `kb_semantic`, etc.) and maintenance primitives (`kb_orphans`, `kb_dead_links`, `kb_bulk_update`, `kb_ingest`, `kb_stats`). There is no **discovery primitive** — no single tool whose description signals "call this first to see what's in the vault." The agent has no cheap way to grok the shape of the vault before reaching for content.

Reference pattern: `plaquette-mcp` (sister project, exposes a Python package's API surface) solves the same class of problem with `overview` and `build_navigation_tree` — both explicitly framed as "start here" entry points. Result: AI clients reliably discover the package shape before drilling into specifics.

## Non-goals

- **Not migrating existing text-formatted tool outputs to JSON.** The 8 access tools (`kb_search`, `kb_list`, `kb_read`, `kb_semantic`, `kb_related`, `kb_orphans`, `kb_dead_links`, `kb_suggest_links`) currently return human-readable text via `formatList`. Migration to JSON is reasonable but out of scope here — it's a separate, user-visible change that warrants its own compat review. See "Out of scope / follow-ups."
- **Not introducing project-aware tools** (e.g. `kb_projects`, `kb_project_read` that codify the `60 Projects/<Name>/{Phases,Plans,Specs}` convention). Considered in brainstorming as Approach B; deferred until evidence shows Approach A is insufficient.
- **Not exposing MCP Resources.** Considered as Approach C; deferred for the same reason and because Claude Code does not render MCP Resources prominently today, limiting expected impact.
- **No index schema changes.** Both new tools are pure aggregations over the existing `notes` table.

## Tool surface

### New: `kb_overview`

**Description (shown to the AI client):**
> Entry point for vault exploration. Run this first when working in the user's Obsidian vault — returns a one-shot snapshot of total note count, top-level folder breakdown, and recently-touched notes. Use the returned folder paths with `kb_tree` (drill-in) or `kb_list` (notes within a folder). No arguments.

**Input schema:** none.

**Output:** JSON object (see "Output shapes").

### New: `kb_tree`

**Description:**
> Return a hierarchical folder tree with note counts per folder. Use after `kb_overview` to drill into a specific section of the vault. Returns folder structure only — no note titles. For listing notes inside a folder, use `kb_list`. Defaults to vault root, depth 2.

**Input schema:**
- `path` (string, optional): vault-relative folder path to root the tree at. Default: vault root.
- `depth` (integer, optional, ≥ 0, max 6): how many levels of children to descend below the root. Default: 2. (`depth=0` → root only, empty `children`. `depth=1` → root + immediate children with empty `children`. `depth=2` → two levels of descent under root.)

**Output:** JSON object (see "Output shapes").

### Sharpened descriptions on 5 existing tools

The discovery-path tools get a one-line workflow hint appended. Maintenance tools (`kb_orphans`, `kb_dead_links`, `kb_bulk_update`, `kb_stats`, `kb_ingest`) are unchanged — they're not on the discovery path.

| Tool | Description hint appended |
|------|---------------------------|
| `kb_search` | "For browsing vault structure, prefer `kb_overview` + `kb_tree`. Use this for keyword content matches." |
| `kb_list` | "Use after `kb_overview`/`kb_tree` to enumerate notes within a known folder." |
| `kb_read` | "Use after `kb_search`/`kb_list`/`kb_tree` once you have a specific path." |
| `kb_semantic` | "For browsing vault structure, prefer `kb_overview` + `kb_tree`. Use this for meaning-based content matches." |
| `kb_related` | "Use after you have a specific note path. For discovering vault structure, use `kb_tree`." |

## Output shapes

### `kb_overview`

```json
{
  "vaultRoot": "/Users/.../obsidian-vault",
  "indexedAt": "2026-05-22T18:04:11Z",
  "totalNotes": 247,
  "topLevelFolders": [
    { "path": "60 Projects", "noteCount": 89, "subfolderCount": 19 },
    { "path": "20 Notes",    "noteCount": 54, "subfolderCount": 0 },
    { "path": "70 Reference","noteCount": 31, "subfolderCount": 4 }
  ],
  "recentlyTouched": [
    {
      "path": "60 Projects/Vault KB/Phases/Phase 2 — Features.md",
      "title": "Phase 2 — Features",
      "updated": "2026-05-22"
    }
  ]
}
```

Notes:
- `topLevelFolders` is sorted by `noteCount` descending (most populated first — what the agent likely wants).
- `noteCount` in `topLevelFolders` is **recursive** (all notes under that folder, including subfolders).
- `recentlyTouched` is limited to 5 entries.
- Folders are read from the indexed `notes.folder` column — i.e. only folders containing at least one AI-accessible note appear. Empty folders are invisible by design (privacy-aligned).

### `kb_tree`

```json
{
  "path": "60 Projects",
  "noteCount": 89,
  "children": [
    {
      "path": "60 Projects/Vault KB",
      "noteCount": 9,
      "children": [
        { "path": "60 Projects/Vault KB/Phases", "noteCount": 2, "children": [] },
        { "path": "60 Projects/Vault KB/Plans",  "noteCount": 1, "children": [] },
        { "path": "60 Projects/Vault KB/Specs",  "noteCount": 2, "children": [] }
      ]
    }
  ]
}
```

Notes:
- `noteCount` is recursive at every level.
- `children` is sorted by `noteCount` descending, then `path` ascending as tiebreak.
- A node at the maximum requested depth returns `children: []` even if subfolders exist below. (Trade-off: keeps payload bounded; if depth limit hit, agent can re-call with explicit `path` to descend further.)
- Path normalization: leading/trailing slashes stripped, matches `kb_list`'s `folder` argument semantics. Calling `kb_tree path="foo/"` and `kb_tree path="foo"` returns the same result.
- If `path` does not correspond to any indexed folder, returns `{ path, noteCount: 0, children: [] }` (not an error — folders are inferred from indexed notes, and an "empty" folder is indistinguishable from a non-existent one to the AI).

## Implementation

No schema changes. All data already lives in `notes.folder` (TEXT column with `/`-separated relative path).

### Two new methods in `src/vault-index.js`

**`overview()`** — two queries, JS aggregation:

```
-- (1) all folders with their direct note counts
SELECT folder, COUNT(*) AS noteCount
FROM notes
WHERE folder <> ''
GROUP BY folder;

-- (2) recently touched
SELECT path, title, updated
FROM notes
WHERE updated IS NOT NULL
ORDER BY updated DESC
LIMIT 5;
```

JS post-processing for `topLevelFolders`: iterate query (1) rows. For each `{folder, noteCount}`:
- `top = folder.split('/')[0]`
- accumulator at `top`: increment `noteCount`; if `folder !== top`, add `folder.split('/')[1]` to a `Set` of immediate subfolders.

Result: `topLevelFolders[i].noteCount` (recursive sum) and `topLevelFolders[i].subfolderCount = subfoldersSet.size` (immediate children only). Sort descending by `noteCount`.

`totalNotes` = sum of all `noteCount` values from query (1) (no separate COUNT query needed).

**`tree({ path, depth })`** — one query, client-side fold:

```
SELECT folder, COUNT(*) AS noteCount
FROM notes
WHERE (folder = ? OR folder LIKE ?)
GROUP BY folder;
```

Then in JS: bucket each row by its position relative to `path`, build a tree, propagate `noteCount` upward by summing children, prune to `depth`.

Inputs normalized via existing `normalizeRelativeVaultPath` (already used by `list`/`readNote`). Hard-excluded folders are not in the index, so no extra filter needed.

### Two new `registerTool()` calls in `src/index.js`

Pattern matches existing tools: zod `inputSchema`, `wrapTool` for stats/error tracking, `toolText(JSON.stringify(...))` for JSON output (same pattern as `kb_stats` today).

### 5 description edits in `src/index.js`

Two-line descriptions per the table above. No code change beyond the string.

## Testing

Pattern follows existing tests in `test/` against the demo fixture `test/fixture/demo-vault/`:

1. **Schema/registration test:** assert `kb_overview` and `kb_tree` are registered with the expected input schemas. (Parallel to existing tool-registration tests.)
2. **`kb_overview` shape test:** call against demo vault, assert top-level keys present, `totalNotes > 0`, `topLevelFolders` non-empty and sorted descending.
3. **`kb_tree` shape test:** default call — root tree at depth 2. Then `path=<known subfolder>` — assert returned `path` matches, `noteCount` matches `kb_list folder=<same>` length.
4. **`kb_tree` depth boundary:** `depth=0` returns root node with `children: []`, regardless of subfolder presence.
5. **`kb_tree` unknown path:** non-existent path returns `noteCount: 0, children: []` (not throw).
6. **Smoke test (`src/smoke.js`):** add both tools to the smoke roundtrip so CI catches MCP wire-format regressions.

Demo vault check: current fixture has 8 notes across 4 folders — enough for `kb_overview` and a basic `kb_tree`. If existing fixture lacks a 2-level subfolder, add one note in a nested folder so the recursion path is exercised. Verified at implementation time, no fixture change planned upfront.

## Out of scope / follow-ups

These are tracked as candidates for separate specs once Approach A lands and we can observe whether the discovery problem is actually solved:

- **JSON migration for the 8 text-formatted tools.** User-visible change (Claude Desktop renders text differently than JSON); needs its own compat note in CHANGELOG and possibly a `format` parameter for transition. Plan: write follow-up spec immediately after this one ships and we have JSON-aware tools in production for ~1 week.
- **Project-aware layer.** `kb_projects` / `kb_project_read` codifying the `60 Projects/<Name>/{Phases,Plans,Specs}` convention. Revisit if A is insufficient and `kb_tree path="60 Projects"` round-trips still feel clunky.
- **MCP Resources.** Re-evaluate when Claude Code (or other clients) render Resources prominently in the UI.

## Acceptance criteria

- `kb_overview` returns the documented shape against the demo vault and the user's real vault, in < 50ms p95.
- `kb_tree` returns the documented shape, respects `path` and `depth` parameters, returns `noteCount: 0, children: []` for unknown paths.
- All 5 sharpened tool descriptions read as documented.
- Existing 11 tools still pass their tests (no regression).
- Smoke test includes both new tools.
- Manual check: in a fresh Claude Code conversation pointed at the real vault, asking "what's in my vault?" results in the agent calling `kb_overview` first (rather than `kb_search` or jumping to filesystem). Pass = agent reaches for `kb_overview` unprompted in ≥ 3 of 5 trial conversations.
