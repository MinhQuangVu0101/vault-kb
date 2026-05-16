# Captures the 4 README screenshots via Edge headless, against the demo vault.
# Prereqs:
# 1) vault-kb running against the demo fixture on http://localhost:7345
#    (typically: $env:VAULT_KB_VAULT_PATH = '...\test\fixture\demo-vault';
#     node src/index.js --web --no-watcher --no-embed --no-llm-summary)
# 2) Microsoft Edge installed

$ErrorActionPreference = "Stop"
$Edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (!(Test-Path $Edge)) {
  $Edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}
if (!(Test-Path $Edge)) {
  Write-Error "Microsoft Edge not found"
  exit 1
}

# Verify server is up
try {
  $stats = Invoke-RestMethod -Uri "http://localhost:7345/api/stats" -TimeoutSec 3
  if ($stats.indexed -ne 8) {
    Write-Warning "Expected 8 indexed notes (demo vault), got $($stats.indexed). Screenshots will reflect whatever vault is connected."
  }
} catch {
  Write-Error "Server not reachable at http://localhost:7345. Start it first."
  exit 1
}

$Out = Join-Path $PSScriptRoot "..\docs\screenshots"
$Out = (Resolve-Path $Out).Path

# URL-encode the demo path (relative to vault root)
$mcpArchPath = [uri]::EscapeDataString("10 Projects/MCP Architecture.md")

$shots = @(
  @{ name = "web-ui-light.png"; url = "http://localhost:7345/?theme=light&q=mcp&path=$mcpArchPath" }
  @{ name = "web-ui-dark.png"; url = "http://localhost:7345/?theme=dark&q=mcp&path=$mcpArchPath" }
  @{ name = "web-ui-graph-light.png"; url = "http://localhost:7345/?theme=light&view=graph" }
  @{ name = "web-ui-graph-dark.png"; url = "http://localhost:7345/?theme=dark&view=graph" }
)

foreach ($shot in $shots) {
  $path = Join-Path $Out $shot.name
  Write-Host "Capturing $($shot.name) ..."
  # --virtual-time-budget gives the JS time to settle (force-graph
  # simulation, search results, etc) before the screenshot
  & $Edge `
    --headless=new `
    --disable-gpu `
    --no-sandbox `
    --window-size=1400,900 `
    --hide-scrollbars `
    --virtual-time-budget=5000 `
    --screenshot="$path" `
    $shot.url 2>$null

  if (Test-Path $path) {
    $size = (Get-Item $path).Length
    Write-Host "  -> $path ($size bytes)"
  } else {
    Write-Warning "  FAILED: $path was not created"
  }
}

Write-Host "Done."
