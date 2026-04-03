# vault-kb

Local, read-only MCP server that makes your Obsidian notes searchable by AI tools (Claude Desktop, Claude Code, etc.).

Only indexes notes with `ai-access: true` in frontmatter — everything else stays private.

## How it works

1. Scans your Obsidian vault for `.md` files with `ai-access: true`
2. Indexes them into a local SQLite database (FTS5 full-text search)
3. Exposes three MCP tools: `kb_search`, `kb_read`, `kb_list`
4. AI tools can search and read your notes — locally, nothing leaves your machine

## Setup

```bash
git clone https://github.com/MinhQuangVu0101/vault-kb.git
cd vault-kb
npm install
```

Create `vault-ai.config.json` in the project root:

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

### CLI tools

```bash
npm run ingest          # Build/rebuild the index
npm run inspect-config  # Show resolved config
npm run smoke           # Run a basic smoke test
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
