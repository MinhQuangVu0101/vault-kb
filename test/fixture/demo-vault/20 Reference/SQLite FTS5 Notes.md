---
ai-access: true
status: active
tags: [sqlite, fts5, reference]
---
# SQLite FTS5 Notes

FTS5 is SQLite's full-text search module. Two key tokenizers:

- **Porter** — stems words (run, running, runs → run)
- **Trigram** — substring matching, finds "vaul" inside "vault"

vault-kb uses both: Porter results rank first, then Trigram fills in.

Referenced in [[MCP Architecture]] for the index layer.
