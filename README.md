# vault-kb

Local, read-only MCP server that makes your Obsidian notes searchable by AI tools (Claude Desktop, Claude Code, etc.).

Only indexes notes with `ai-access: true` in frontmatter — everything else stays private.

## How it works

1. Scans your Obsidian vault for `.md` files with `ai-access: true`
2. Indexes them into a local SQLite database (FTS5 full-text search)
3. Exposes MCP tools: `kb_search`, `kb_read`, `kb_list`, `kb_ingest`, `kb_stats`
4. AI tools can search and read your notes — locally, nothing leaves your machine

## Setup

```bash
git clone https://github.com/MinhQuangVu0101/vault-kb.git
cd vault-kb
npm install
```

Point the server at your vault. Either:

**A. Env var (recommended, portable across machines):**

```bash
export VAULT_KB_VAULT_PATH="$HOME/Documents/obsidian-vault"
```

**B. Config file** — create `vault-ai.config.json` in the project root:

```json
{
  "vaultRoot": "/path/to/your/obsidian/vault",
  "indexPath": ".data/vault-index.sqlite",
  "hardExcludedFolders": [
    ".obsidian",
    ".git"
  ]
}
```

The env var takes precedence when both are set. `indexPath` and `hardExcludedFolders` are optional and have sensible defaults.

### Mac quick setup

```bash
git clone https://github.com/MinhQuangVu0101/vault-kb.git ~/Documents/dev/vault-kb
cd ~/Documents/dev/vault-kb && npm install
echo 'export VAULT_KB_VAULT_PATH="$HOME/Documents/obsidian-vault"' >> ~/.zshrc
source ~/.zshrc
```

Then in your vault's `.mcp.json`:

```json
{
  "mcpServers": {
    "vault-kb": {
      "command": "node",
      "args": ["/Users/YOU/Documents/dev/vault-kb/src/index.js"]
    }
  }
}
```

### Windows quick setup

```powershell
git clone https://github.com/MinhQuangVu0101/vault-kb.git C:\code\vault-kb
cd C:\code\vault-kb
npm install
setx VAULT_KB_VAULT_PATH "C:\Users\YOU\Documents\obsidian-vault"
```

Restart your terminal so the env var takes effect. Then in your vault's `.mcp.json`:

```json
{
  "mcpServers": {
    "vault-kb": {
      "command": "node",
      "args": ["C:\\code\\vault-kb\\src\\index.js"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vault-kb": {
      "command": "node",
      "args": ["/path/to/vault-kb/src/index.js"]
    }
  }
}
```

### Claude Code

Works automatically when running in the vault directory with the MCP server configured.

## Usage

Once configured, your AI tool can:

- **`kb_search`** — Full-text search across indexed notes (FTS5/BM25)
- **`kb_semantic`** — Embedding-based semantic search via local Ollama
- **`kb_read`** — Read a specific note by path (includes backlinks + outlinks)
- **`kb_list`** — List notes by folder, tag, or status
- **`kb_ingest`** — Rebuild the index
- **`kb_bulk_update`** — Batch frontmatter edits with dry-run + revert bundle
- **`kb_suggest_links`** — Top-N similar notes that are NOT already linked, each with a one-sentence LLM-generated reason (via local Ollama chat model)
- **`kb_stats`** — Index health: counts, skip breakdown, watcher state, embedding coverage

### Semantic search (optional)

`kb_semantic` needs a local Ollama with an embedding model:

```bash
brew install ollama
brew services start ollama
ollama pull nomic-embed-text
ollama pull llama3.2:3b   # for kb_suggest_links reasoning (optional)
```

Embeddings populate automatically on startup and watcher updates. If Ollama is offline, regular search/list still work — only `kb_semantic` is affected.

`kb_suggest_links` uses the chat model `llama3.2:3b` (configurable via `llmModel` in `vault-ai.config.json`) for the per-suggestion reason. If the chat model is unavailable, suggestions still come back — just without the `why:` line.

### Observability

Every tool call is logged as a JSON line to `~/.cache/vault-kb/vault-kb.log` (rotates at 10MB). Failures also show up in `kb_stats.recentErrors` (last 20).

### CLI tools

```bash
npm run ingest          # Build/rebuild the index
npm run inspect-config  # Show resolved config
npm run smoke           # Run a basic smoke test
npm test                # Run unit tests
npm run regression      # Read every indexed note, report failures
npm run bulk -- --help  # Bulk frontmatter edits (dry-run by default)
npm start               # Start the MCP server (stdio)
npm start -- --no-embed # Start without semantic embeddings
npm start -- --no-llm-summary  # Disable LLM reasoning (score-only suggestions)
npm start -- --no-watcher # Start without the file watcher
npm start -- --web      # Also serve a local web UI at http://127.0.0.1:7345
```

## Privacy

- Only notes with `ai-access: true` in frontmatter are indexed
- Folders in `hardExcludedFolders` are always skipped (e.g. journals, therapy notes)
- The SQLite database is local — nothing is sent externally
- The MCP server is read-only — it cannot modify your vault

## Tech

- Node.js >= 20
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) for tool registration
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) with FTS5 for search
- [gray-matter](https://github.com/jonschlinkert/gray-matter) for frontmatter parsing

## License

MIT
