# Demo vault for vault-kb screenshots and CI smoke tests

8 fake notes spanning 4 numbered folders so the UI shows realistic
patterns (folder-rainbow colors, hub-and-spoke link cluster, orphan,
dead link, cross-cluster note).

## Use for screenshots

```bash
# From the repo root:
VAULT_KB_VAULT_PATH=$(pwd)/test/fixture/demo-vault node src/index.js --web --no-watcher --no-embed --no-llm-summary
```

```powershell
# Windows PowerShell:
$env:VAULT_KB_VAULT_PATH = "$pwd\test\fixture\demo-vault"
node src/index.js --web --no-watcher --no-embed --no-llm-summary
```

Then open http://localhost:7345 and capture the three screenshots
documented in docs/screenshots/HOW_TO_CAPTURE.md.

## Use for CI smoke

The bundled fixture means `npm run smoke` can be re-enabled in
.github/workflows/ci.yml by setting VAULT_KB_VAULT_PATH before the
smoke step.
