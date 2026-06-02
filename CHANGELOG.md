# Changelog

All notable changes to vault-kb. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

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

[0.3.0]: https://github.com/MinhQuangVu0101/vault-kb/releases/tag/v0.3.0
[0.2.0]: https://github.com/MinhQuangVu0101/vault-kb/releases/tag/v0.2.0
