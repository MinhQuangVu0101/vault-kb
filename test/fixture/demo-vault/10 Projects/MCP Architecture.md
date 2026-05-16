---
ai-access: true
status: active
tags: [mcp, architecture, design]
---
# MCP Architecture

The Model Context Protocol lets AI tools talk to local data sources
through a stdio JSON-RPC interface. This note is the architectural
overview for the demo project.

## Components

- **Server** — exposes tools via stdio
- **Client** — Claude Desktop, Claude Code, or any MCP-aware app
- **Index** — local SQLite database, FTS5 for full-text search
- **Embeddings** — optional, via local Ollama

See [[MCP Research]] for background and [[Changelog]] for what shipped.
Related: [[SQLite FTS5 Notes]], [[Embedding Models]].
