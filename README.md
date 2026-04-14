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

- **`kb_search`** — Full-text search across indexed notes
- **`kb_read`** — Read a specific note by path
- **`kb_list`** — List notes by folder, tag, or status
- **`kb_ingest`** — Rebuild the index
- **`kb_stats`** — Report index health: indexed count, skip breakdown (missingAccess / explicitFalse / hardExcluded / parseError), last ingest, recent errors

### Observability

Every tool call is logged as a JSON line to `~/.cache/vault-kb/vault-kb.log` (rotates at 10MB). Failures also show up in `kb_stats.recentErrors` (last 20).

### CLI tools

```bash
npm run ingest          # Build/rebuild the index
npm run inspect-config  # Show resolved config
npm run smoke           # Run a basic smoke test
npm test                # Run unit tests
npm run regression      # Read every indexed note, report failures
npm start               # Start the MCP server (stdio)
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
