# Changelog

All notable changes to vault-kb. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- `kb_bulk_revert` - undo a `kb_bulk_update` by restoring frontmatter from its revert bundle. Reverts the newest bundle for the current vault by default, or a specific one via `bundleId`; dry-run unless `apply: true`. Restore is field-level (only the keys the bulk edit changed), so later edits to other keys survive. Notes whose frontmatter changed since the edit are skipped and reported as `drifted` unless `force: true`. Bundles now record the vault root and cannot be applied to a different vault, and a revert that restores anything writes its own bundle, so it too is undoable.

### Fixed
- Wikilinks and filenames are now compared in one Unicode form (NFC). macOS reports filenames NFD-decomposed while links in note bodies are typed NFC, so every note whose name contains an umlaut or accent was reported as a false positive by `kb_dead_links` (link "broken" although the file exists) and `kb_orphans` (note "orphaned" although it is linked). Index keys are NFC-normalized in `normalizeRelativeVaultPath`, the link resolver canonicalizes both sides, and file access falls back to the NFD form on byte-strict filesystems (Linux).
- `.base` files (Obsidian Bases) are now valid wikilink targets. `[[Freelance.base]]` no longer shows up as a dead link; ingest records `*.base` paths in a new `link_targets` table (hard-excluded folders stay excluded) that the resolver consults alongside notes. Requires one `kb_ingest` run after updating so the table gets populated.
- The server now exits when stdin reaches EOF, i.e. when the MCP client process dies (MCP stdio convention). Previously every crashed or hard-killed Claude/Codex session left an orphaned server behind (PPID 1) that kept running for days; each orphan held ~1600 open file descriptors through the vault watcher, and enough of them exhausted the macOS global file table (ENFILE, `kern.num_files` at the `kern.maxfiles` ceiling). SIGINT/SIGTERM shutdown now shares the same idempotent path and force-exits after 2 s if cleanup hangs.

### Changed
- The vault watcher starts lazily on the first tool call instead of at server startup. chokidar without fsevents holds one open file descriptor per watched file on macOS, so an idle MCP session dropped from ~1600 open fds to ~47. If the first tool call arrives more than 60 s after startup, the index is refreshed once before the watcher takes over, so no edits are missed. `--web` mode still starts the watcher immediately.
- CI and `prepublishOnly` now run a TypeScript `checkJs` pass (`npm run typecheck`) over `src/` and `scripts/`. Stale JSDoc option types across several modules were corrected in the process; no runtime behavior change.

### Security
- Bumped transitive dependencies via `npm audit fix` (hono, @hono/node-server, fast-uri, ip-address, express-rate-limit, js-yaml, qs), clearing 7 advisories (2 high). Lockfile-only change.

## [0.3.2] - 2026-06-19

### Fixed
- `kb_tree` now normalizes folder paths the same way as the other path-based tools (`normalizeRelativeVaultPath`), so backslash (`10 Projects\Sub`), `./`-prefixed, and duplicate-separator paths resolve to the correct subtree instead of returning empty results. It also rejects `..` traversal consistently.
- The shared path normalizer now strips trailing slashes. This fixes a latent case where `kb_list`, `kb_search`, and `kb_semantic` returned no results for a folder argument with a trailing slash (e.g. `10 Projects/`).

## [0.3.1] - 2026-06-09

### Fixed
- `.stversions` (Syncthing File Versioning) added to the default `hardExcludedFolders`. Without it, enabling Syncthing versioning floods the index with stale snapshot copies that dominate `kb_dead_links` and `kb_orphans` output (141 phantom notes in the author's vault).
- Folder filters in `kb_list` and `kb_search` now escape SQL LIKE wildcards (`%`, `_`, `\`), so folder names containing them no longer match similarly named siblings. Same fix as `kb_tree` got in 0.3.0; `kb_semantic` already escaped and gained regression coverage.

## [0.3.0] — 2026-05-23

### Added
- `kb_overview` — entry-point snapshot of the vault: total note count, top-level folders with recursive note counts and subfolder counts, recently touched notes. Designed as the "start here" call for AI clients so they consult the vault before reaching for other context.
- `kb_tree` — hierarchical folder tree with recursive note counts per folder. Parameters: `path` (optional, default vault root), `depth` (optional, default 2, max 6).

### Changed
- Tool descriptions for `kb_search`, `kb_read`, `kb_list`, `kb_semantic`, and `kb_related` now include workflow hints pointing to `kb_overview` / `kb_tree` for vault-structure discovery.

## [0.2.0] — 2026-05-16

Initial public release on npm. Captures everything shipped through Phase 1 (Foundation) and Phase 2 (Features).

### MCP tools

- `kb_search` — keyword search via SQLite FTS5 (BM25 ranking) with trigram fuzzy fallback.
- `kb_read` — read one note; returns backlinks + outlinks (with unresolved links flagged).
- `kb_list` — list AI-accessible notes, filterable by folder / tag / status.
- `kb_ingest` — rebuild the index on demand.
- `kb_semantic` — embedding-based search via local Ollama (`nomic-embed-text` by default), cosine similarity, hash-skip when content unchanged.
- `kb_related` — graph-based related notes via wikilinks (weight 3.0), shared tags (2.0), shared folder (1.0); up to 2-hop with damping.
- `kb_orphans` — notes with no incoming or outgoing links.
- `kb_dead_links` — wikilinks that don't resolve to any indexed note.
- `kb_suggest_links` — semantic + lexical suggestions for new links, optionally with one-line LLM-generated reasons.
- `kb_bulk_update` — match by folder / tag / frontmatter / paths; ops include `addTags`, `removeTags`, `setFields`, `unsetFields`, `setAccess`. Dry-run by default; every applied run writes a revert bundle to `~/.cache/vault-kb/reverts/`.
- `kb_stats` — index health, embedding coverage, watcher event counts, Ollama reachability.

### Web UI

- Optional local dashboard at `http://127.0.0.1:7345` (`--web` flag, port via `VAULT_KB_WEB_PORT`).
- Search view (keyword + semantic toggle), graph view (force-directed via `force-graph`), URL-driven theme/view/path state.
- Bound to `127.0.0.1` only; no auth, no telemetry.
- Optional remote access via Cloudflare Tunnel + Cloudflare Access (documented in README).

### Infrastructure

- File watcher (chokidar) for incremental reindex within ~300 ms of save; `--no-watcher` escape hatch.
- Ollama health-check on boot — `MODEL_MISSING` / `UNREACHABLE` surfaced on stderr; FTS5 keeps working regardless.
- Portable config: `VAULT_KB_VAULT_PATH` env var or `vault-ai.config.json`. Hard-excluded folders configurable.
- Privacy model: only notes with `ai-access: true` are indexed; `hardExcludedFolders` is never touched.
- CI: Biome lint + `node --test` unit suite (105 tests) + smoke test against a bundled demo vault.

### Notes

- Requires Node.js ≥ 20.
- Semantic search requires a running Ollama instance and a pulled embedding model (`ollama pull nomic-embed-text`). Without it, keyword + fuzzy search still work.
- `better-sqlite3` is a native module; first install compiles on systems without a prebuild.

[0.3.1]: https://github.com/MinhQuangVu0101/vault-kb/releases/tag/v0.3.1
[0.3.0]: https://github.com/MinhQuangVu0101/vault-kb/releases/tag/v0.3.0
[0.2.0]: https://github.com/MinhQuangVu0101/vault-kb/releases/tag/v0.2.0
