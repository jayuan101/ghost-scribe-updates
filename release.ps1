param([string]$Token = "")

if ($Token) {
  $env:GH_TOKEN = $Token
} elseif (-not $env:GH_TOKEN) {
  Write-Host "ERROR: GH_TOKEN not set. Run this once to save it permanently:" -ForegroundColor Red
  Write-Host '  [System.Environment]::SetEnvironmentVariable("GH_TOKEN", "ghp_...", "User")' -ForegroundColor Yellow
  exit 1
}

Write-Host "Building and publishing Ghost Scribe..." -ForegroundColor Cyan
npm run release
