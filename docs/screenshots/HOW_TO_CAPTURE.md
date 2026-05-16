# How to capture README screenshots

Three screenshots feed the README "Screenshots" section. Capture them
against the demo vault fixture so personal note titles never appear
in published images.

## 1. Start vault-kb against the demo vault

```bash
# macOS / Linux
VAULT_KB_VAULT_PATH=$(pwd)/test/fixture/demo-vault \
  node src/index.js --web --no-watcher --no-embed --no-llm-summary
```

```powershell
# Windows PowerShell
$env:VAULT_KB_VAULT_PATH = "$pwd\test\fixture\demo-vault"
node src/index.js --web --no-watcher --no-embed --no-llm-summary
```

The server prints `[vault-mcp] Web UI: http://127.0.0.1:7345`.

## 2. Resize your browser to ~1400x900

For consistent README rendering. Devtools → device-emulation or
just drag the window.

## 3. Capture three states

### `web-ui-light.png`

1. Light theme (toggle the sun/moon button if needed)
2. Search bar: type `mcp` and press Enter
3. Click the first result ("MCP Architecture") so the detail pane and
   Connections sidebar populate
4. Take an OS screenshot of the whole vault-kb window
5. Save to `docs/screenshots/web-ui-light.png`

### `web-ui-dark.png`

1. Toggle to dark theme
2. Same search (`mcp`) with "MCP Architecture" still selected
3. Capture and save to `docs/screenshots/web-ui-dark.png`

### `web-ui-graph.png`

1. Toggle back to light theme
2. Click the "Graph" tab in the left nav
3. Wait ~3 seconds for the force simulation to settle
4. Capture and save to `docs/screenshots/web-ui-graph.png`

## 4. Verify and commit

```bash
ls -la docs/screenshots/web-ui-*.png
git add docs/screenshots/
git commit -m "docs: add README screenshots from demo vault"
```

The README's image links should now render on GitHub.
