# kb_bulk_revert design

Date: 2026-07-17
Status: approved (design), pending implementation plan
Revision: 2 (incorporates codex-me spec review)

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
- Only touch the frontmatter keys the bulk edit actually changed; leave every
  other later edit intact.
- Preview before writing, matching the dry-run/apply model of `kb_bulk_update`.

## Non-goals (YAGNI)

- Bundle retention or cleanup. Bundles keep accumulating in cache as they do
  today; cleanup is a possible follow-up, not part of this work.
- Web-UI revert. This tool is MCP-only, like `kb_bulk_update`.
- Reverting body content. Bulk update only ever touches frontmatter, so revert
  restores frontmatter keys only and preserves the note body as it currently is.

## Tool surface

One new MCP tool, `kb_bulk_revert`, mirroring `kb_bulk_update`'s dry-run/apply
shape. Rejected alternatives: a separate list tool (grows the surface from 13
to 15 tools for an occasional operation) and a `revert` mode on
`kb_bulk_update` (overloads one schema and description with two opposite
behaviors).

## Contract

`kb_bulk_revert({ bundleId?, apply?, force? })`

Inputs:
- `bundleId` (string, optional): a bundle id (see Bundle format). Omitted means
  the newest bundle *for the current vault*. Must match `^[0-9TZ-]+$`; a value
  that fails the regex or matches no enumerated bundle throws.
- `apply` (boolean, default false): dry-run unless true.
- `force` (boolean, default false): also restore notes flagged as drifted, and
  allow applying old-format (v1) bundles whose drift cannot be checked.

Field-level model: the bulk edit changed a set of keys K (derivable from the
bundle's per-note before/after). Revert only ever writes keys in K. Keys outside
K are never touched, so unrelated later edits survive even under `force`.

Dry-run output:
```json
{
  "applied": false,
  "bundleId": "<id>",
  "vaultMatch": true,
  "driftCheck": "available" | "unavailable",
  "willRestore": [{ "path": "note.md", "diff": { "field": { "before": "cur", "after": "restored" } } }],
  "drifted":     [{ "path": "note.md", "keys": ["status"] }],
  "missing":     ["gone.md"],
  "unreadable":  [{ "path": "bad.md", "error": "..." }],
  "availableBundles": [{ "id": "<id>", "createdAt": "<iso>", "notes": 3 }]
}
```
`diff` describes the restore as current value -> restored value, per key in K,
using the shape `kb_bulk_update` already returns. `willRestore` lists notes that
will be restored: under default that excludes drifted notes; under `force:true`
it includes them. `drifted` always lists notes with drift plus which keys
drifted, regardless of `force`.

Apply output: same fields with `applied: true`, plus `revertFile` pointing at
the new bundle written for this revert (so the revert is itself undoable).
`willRestore` reflects what was actually restored.

Errors and the empty case:
- `bundleId` given but no matching enumerated bundle, or failing the id regex ->
  throw, in dry-run and apply.
- Bundle file exists but its JSON is malformed or missing `entries` -> throw
  (the bundle cannot be trusted).
- No bundles exist for the current vault: dry-run returns `applied:false`, empty
  `availableBundles`, and a `message` saying there is nothing to revert (no
  throw). Apply in this state -> throw.
- Vault mismatch or v1 bundle without `force` on apply: throw with a message
  naming the reason (see Vault identity and v1 handling).

## Bundle format

Version 2 bundle (written by this change):
```json
{
  "schema": 2,
  "id": "<sanitized-ts>",
  "createdAt": "<original ISO timestamp>",
  "vaultRoot": "/abs/path/to/vault",
  "entries": [
    { "path": "note.md", "frontmatter": { /* before */ }, "after": { /* post-edit */ } }
  ]
}
```
- `frontmatter` keeps meaning "before" and stays as the entry's first data key
  so existing on-disk bundles and the current `bulk.test.js` assertion
  (`entries[0].frontmatter`) remain valid.
- `after` is new and drives both drift detection and the K key set.
- `id` is the sanitized timestamp (the filename stem after `revert-`);
  `createdAt` is the original unsanitized ISO string for display. This removes
  the old ambiguity where the stored `ts` was already dash-sanitized but
  presented as ISO.
- `vaultRoot` is the absolute vault path, for isolation (below).

Version 1 bundles are any already on disk: `{ ts, entries:[{path, frontmatter}] }`,
no `after`, `vaultRoot`, or `schema`. They are detected by the absence of
`schema`/`after`.

`writeRevertBundle` is extended to emit schema 2. `after` is already computed as
`nextData` in `runBulkUpdate`.

## Vault identity and isolation

The revert cache is global but a user may run vault-kb against several vaults
(e.g. a Mac vault and a Pi vault). Restoring paths from the wrong vault is a
data-loss risk. Mitigation:
- v2 bundles record `vaultRoot`.
- `availableBundles` and default (newest) selection are filtered to bundles
  whose `vaultRoot` equals the current `config.vaultRoot`.
- An explicit `bundleId` pointing at a bundle from another vault sets
  `vaultMatch:false` in dry-run and throws on apply.
- v1 bundles have no `vaultRoot`; they are excluded from default selection and
  from the vault-filtered `availableBundles`, and can only be applied via an
  explicit `bundleId` together with `force`.

## Revert algorithm

Selection: enumerate bundle files in the revert dir by basename (never by
constructing a path from `bundleId`). Filter to the current vault. Newest =
the greatest id (last entry in ascending lexical sort); the id is a timestamp
with `:`/`.` replaced by `-`, which still sorts lexically in chronological
order.

For each entry in the chosen bundle, compute K = keys where `before` and `after`
differ (stable deep comparison). Then:
1. Resolve the entry path under the vault root and verify containment; a path
   that normalizes outside the vault is reported in `unreadable` with a reason
   and skipped (defensive against a corrupt bundle).
2. If the file does not exist -> `missing`, skip.
3. Parse current frontmatter with `gray-matter`; on parse failure -> `unreadable`,
   skip.
4. Drift: for each k in K, k drifted if current[k] deep-differs from `after[k]`.
   If any key in K drifted, the note is drifted (record it and the drifted keys);
   skip unless `force`. v1 bundles (no `after`) cannot compute this ->
   `driftCheck:"unavailable"`, and apply requires `force`.
5. Restore (field-level inverse patch over K only): for each k in K, if `before`
   had k set current[k] = before[k], else delete k. Keys outside K are left
   exactly as they are. Re-stringify with `matter.stringify(currentBody, next)`,
   preserving the current body.

Dry-run performs 1-4 and computes the per-key restore diff but writes nothing.

Apply ordering (so the revert is always itself undoable):
1. Compute the full restore plan.
2. Write the new pre-revert bundle first, capturing each about-to-be-restored
   note's current frontmatter as `before` and its restored frontmatter as
   `after`, tagged with the current `vaultRoot`.
3. Then write the note files.
4. Re-index (see below).
If a file write fails mid-run, the pre-revert bundle already exists, so the
partial revert can itself be reverted; the tool reports how many notes were
written before the failure.

## Drift and equality

Drift and the K computation use a stable deep-equality helper (recursively
key-sorted comparison), not shallow `JSON.stringify`-per-key, so nested-object
key ordering does not produce false drift. This helper lives in `bulk.js` and is
unit-tested directly.

## Re-index ownership

`runBulkRevert` in `src/bulk.js` is pure file/bundle logic and returns the list
of restored paths. The `kb_bulk_revert` handler in `src/index.js` performs the
`vaultIndex.ingestOne` loop over those paths, matching where `kb_bulk_update`
already does its post-apply re-index. No indexing in `bulk.js`.

## Testability

`REVERT_DIR` is currently a hardcoded module constant, so the existing
`kb_bulk_update` "apply" test writes a bundle into the real
`~/.cache/vault-kb/reverts/`. Thread an optional `revertDir` through
`runBulkUpdate` and `runBulkRevert`, defaulting to the existing cache path.
Tests pass a temp dir. This isolates revert tests and de-pollutes the existing
bulk test.

## Bundle filename safety

Bundle files are named `revert-<id>.json` where id is a millisecond timestamp,
so fast or chained operations can collide. Create with an exclusive-write flag
(`wx`); on `EEXIST`, append an incrementing `-N` suffix to the id until the
create succeeds. The id stored inside the bundle matches the filename stem.

## Implementation surface

- `src/bulk.js`: extend `writeRevertBundle` (schema 2 with `id`/`createdAt`/
  `vaultRoot`, exclusive create + collision suffix, accept `revertDir`); add a
  stable deep-equal helper; add `listBundles(revertDir, vaultRoot)`; add
  `runBulkRevert({ config, bundleId, apply, force, revertDir, logger })`
  returning the restore result plus restored paths.
- `src/index.js`: register `kb_bulk_revert`; on apply, re-ingest restored paths.
- `test/bulk-revert.test.js`: new suite (below).
- `test/bulk.test.js`: unaffected assertions must still pass; may gain a
  `revertDir` temp-dir to stop polluting the real cache.
- `CHANGELOG.md`: Unreleased -> Added.
- `README.md` / any doc enumerating tools: add `kb_bulk_revert`, bump the count.

## Testing

New `test/bulk-revert.test.js`, temp-vault pattern from `bulk.test.js`, every
call pointing `revertDir` at a temp dir:
- Round-trip: bulk edit then revert restores the exact pre-edit frontmatter
  values (parsed-data equality).
- Field-level: a later edit to a key the bulk op did NOT touch survives the
  revert (default and `force`).
- Dry-run writes nothing and reports `willRestore` with per-key diffs.
- Drift on a bulk-changed key: skipped without `force` and listed in `drifted`
  with the key names; restored with `force`; under `force`, also in
  `willRestore`.
- Missing note: reported in `missing`, not thrown; others still restored.
- Unreadable note (unparseable frontmatter): reported in `unreadable`, not
  thrown; others still restored.
- Path-containment: an entry whose path escapes the vault root is reported and
  skipped, never written outside the vault.
- `bundleId` targets an older bundle when several exist; default picks newest.
- Vault isolation: a bundle tagged with a different `vaultRoot` is excluded from
  default selection and refuses apply; explicit `bundleId` throws on apply.
- v1 (old-format) bundle: excluded from default selection; explicit id + `force`
  does a blind restore with `driftCheck:"unavailable"`; without `force` it
  throws on apply.
- Apply writes a new v2 revert bundle (redo path) capturing pre-revert state,
  written before the note files.
- Filename collision: two applies in the same millisecond produce two distinct
  bundle files.
- Stable deep-equal helper: unit test that nested-object key reordering is not
  treated as drift.

`kb_bulk_update`'s existing tests must still pass.

## Success criteria

For any `kb_bulk_update` apply followed immediately by `kb_bulk_revert` with no
intervening edits, every touched note's frontmatter returns to its pre-edit
values (parsed-frontmatter equality via `gray-matter`, not byte-for-byte YAML:
comments, quoting, and key formatting are not guaranteed). Later edits to keys
the bulk op did not touch always survive. The revert is itself undoable via the
bundle it writes, and a bundle from another vault can never be applied to the
current one.
