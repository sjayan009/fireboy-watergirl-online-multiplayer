# Runs Cloudflare Tunnel for the game host. Start the host first (npm run server:dev),
# so it is listening on http://localhost:8080, then run this in a second terminal.
#
#   pwsh scripts/tunnel.ps1          # named tunnel via cloudflared/config.yml (stable hostname)
#   pwsh scripts/tunnel.ps1 -Quick   # ephemeral *.trycloudflare.com URL (no account/domain)
param(
  [switch]$Quick
)

$ErrorActionPreference = "Stop"

$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflaredCommand) {
  $cloudflaredCommand = Get-Item "C:\Program Files (x86)\cloudflared\cloudflared.exe" -ErrorAction SilentlyContinue
}
if (-not $cloudflaredCommand) {
  $cloudflaredCommand = Get-Item "C:\Program Files\cloudflared\cloudflared.exe" -ErrorAction SilentlyContinue
}
if (-not $cloudflaredCommand) {
  Write-Error "cloudflared is not installed. Install it with: winget install --id Cloudflare.cloudflared"
  exit 1
}

$cloudflared = $cloudflaredCommand.Source
if (-not $cloudflared) {
  $cloudflared = $cloudflaredCommand.FullName
}

if ($Quick) {
  Write-Host "Starting an ephemeral quick tunnel to http://localhost:8080 ..."
  Write-Host "Copy the printed https://<random>.trycloudflare.com host into VITE_GAME_SERVER_URL as wss://<random>.trycloudflare.com,"
  Write-Host "then redeploy Vercel. The URL changes every run, so this is for testing only."
  & $cloudflared tunnel --url http://localhost:8080
  return
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$config = Join-Path $repoRoot "cloudflared\config.yml"
if (-not (Test-Path $config)) {
  Write-Error "Missing $config. Copy cloudflared/config.example.yml to cloudflared/config.yml and fill it in."
  exit 1
}

Write-Host "Starting named tunnel using $config ..."
& $cloudflared tunnel --config $config run
