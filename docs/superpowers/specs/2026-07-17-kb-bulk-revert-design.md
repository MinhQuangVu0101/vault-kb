# kb_bulk_revert design

Date: 2026-07-17
Status: approved (design), pending implementation plan

## Problem

`kb_bulk_update` applies frontmatter changes across many notes and writes a
revert bundle to `~/.cache/vault-kb/reverts/revert-<ts>.json` recording each
touched note's prior frontmatter. Nothing reads that bundle back, so there is
no undo. To reverse a bulk edit today a user must hand-apply the JSON or ask
Claude to reconstruct the change. The safety net is half-built: the data is
saved but unreachable.

This adds `kb_bulk_revert`, an MCP tool that restores frontmatter from a saved
bundle.

## Goals

- Undo the most recent bulk edit with no arguments (the common case).
- Target an older bundle by id when needed.
- Never silently clobber changes made to a note after the bulk edit.
- Preview before writing, matching the dry-run/apply model of `kb_bulk_update`.

## Non-goals (YAGNI)

- Bundle retention or cleanup. Bundles keep accumulating in cache as they do
  today; cleanup is a possible follow-up, not part of this work.
- Web-UI revert. This tool is MCP-only, like `kb_bulk_update`.
- Reverting body content. Bulk update only ever touches frontmatter, so revert
  restores frontmatter only and preserves the note body as it currently is.

## Tool surface

One new MCP tool, `kb_bulk_revert`, mirroring `kb_bulk_update`'s dry-run/apply
shape. Rejected alternatives: a separate list tool (grows the surface from 13
to 15 tools for an occasional operation) and a `revert` mode on
`kb_bulk_update` (overloads one schema and description with two opposite
behaviors).

## Contract

`kb_bulk_revert({ bundleId?, apply?, force? })`

Inputs:
- `bundleId` (string, optional): the timestamp portion of a bundle filename
  (`revert-<ts>.json` → id `<ts>`). Omitted means the newest bundle. Selection
  is by descending filename sort: the `<ts>` is an ISO timestamp with `:` and
  `.` replaced by `-`, which still sorts lexically in chronological order, so
  the last filename is the newest bundle.
- `apply` (boolean, default false): dry-run unless true.
- `force` (boolean, default false): also restore notes flagged as drifted.

Dry-run output:
```json
{
  "applied": false,
  "bundleId": "<ts>",
  "driftCheck": "available" | "unavailable",
  "willRestore": [{ "path": "note.md", "diff": { "field": { "before": "x", "after": "y" } } }],
  "drifted":     [{ "path": "note.md" }],
  "missing":     ["gone.md"],
  "availableBundles": [{ "id": "<ts>", "ts": "<iso>", "notes": 3 }]
}
```
`diff` here describes the restore (current value → recorded `before`), using the
same shape `kb_bulk_update` already returns.

Apply output: same fields with `applied: true`, plus `revertFile` pointing at
the new bundle written for this revert (so the revert is itself undoable), and
the `willRestore` list reflects what was actually restored.

Errors and the empty case:
- A given `bundleId` that matches no bundle → throw, in both dry-run and apply.
- No bundles exist at all: dry-run returns `applied:false`, empty
  `availableBundles`, and a `message` saying there is nothing to revert (no
  throw). Apply in this state → throw, since there is nothing to write.

## Bundle format change

Current entry shape:
```json
{ "path": "note.md", "frontmatter": { /* before */ } }
```
New entry shape:
```json
{ "path": "note.md", "frontmatter": { /* before */ }, "after": { /* post-edit */ } }
```
The `frontmatter` key keeps meaning "before" and stays first so existing
bundles on disk and the current `bulk.test.js` assertion (`entries[0].frontmatter`)
remain valid. `after` is new and drives drift detection. Bundles written before
this change lack `after`; revert falls back to blind restore for them and sets
`driftCheck: "unavailable"`.

`writeRevertBundle` is extended to record `after` (already computed as
`nextData` in `runBulkUpdate`).

## Revert algorithm

Given the selected bundle, for each entry:
1. If the file does not exist under the vault root → add to `missing`, skip.
2. Parse current frontmatter with `gray-matter`.
3. If the entry has `after` and current frontmatter deep-differs from `after` →
   the note changed since the bulk edit. Add to `drifted`; skip unless `force`.
4. Otherwise restore: re-stringify the note with `matter.stringify(currentBody,
   before)`, preserving the current body. Record the restore diff.

Dry-run performs steps 1-3 and computes diffs but writes nothing. Apply
performs the writes, re-ingests each restored note via `vaultIndex.ingestOne`
(matching `kb_bulk_update`'s post-apply re-index), and writes a fresh revert
bundle capturing the pre-revert state as `before` and the restored state as
`after`.

Deep comparison uses the same `JSON.stringify`-per-key logic already in
`frontmatterDiff`, so key ordering does not produce false drift.

## Testability change

`REVERT_DIR` is currently a hardcoded module constant, so the existing
"apply" test writes a bundle into the real `~/.cache/vault-kb/reverts/`. Thread
an optional `revertDir` parameter through `runBulkUpdate` and the new
`runBulkRevert`, defaulting to the existing cache path. Tests pass a temp dir.
This isolates revert tests and de-pollutes the existing bulk test as a bonus.

## Implementation surface

- `src/bulk.js`: extend `writeRevertBundle` (record `after`, accept
  `revertDir`); add `runBulkRevert({ config, bundleId, apply, force, revertDir,
  logger })` plus a small `listBundles(revertDir)` helper.
- `src/index.js`: register the `kb_bulk_revert` tool; on apply, the re-ingest
  loop mirrors `kb_bulk_update`.
- `test/bulk-revert.test.js`: new suite (see below).
- `CHANGELOG.md`: Unreleased → Added.
- Tool count in any docs/README that enumerates tools.

## Testing

New `test/bulk-revert.test.js`, temp-vault pattern from `bulk.test.js`, every
call pointing `revertDir` at a temp dir:
- Round-trip: bulk edit then revert restores the exact original frontmatter.
- Dry-run writes nothing and reports `willRestore`.
- Drift: a note's frontmatter changed after the edit is skipped without
  `force`, restored with `force`, and always listed in `drifted`.
- Missing note: reported in `missing`, not thrown, others still restored.
- `bundleId` targets an older bundle when several exist; default picks newest.
- Old-format bundle (no `after`): blind restore, `driftCheck: "unavailable"`.
- Apply writes a new revert bundle (redo path) capturing the pre-revert state.

`kb_bulk_update`'s existing tests must still pass unchanged.

## Success criteria

For any `kb_bulk_update` apply followed immediately by `kb_bulk_revert` with no
intervening edits, every touched note's frontmatter returns to its exact
pre-edit state, and the revert itself is undoable via the bundle it writes.
