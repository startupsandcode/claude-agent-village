# Creates the demo target repo next to this village checkout, pushes it to your GitHub account,
# and files the three demo issues (#1 TIV authority, #2 sanctioned territory, #3 not ready).
#
#   .\demo\setup-target.ps1                      # private repo named village-demo-triage
#   .\demo\setup-target.ps1 -Name triage-live -Visibility public
#
# Needs git, gh (logged in: gh auth status) and Node 20+. Creates a repo on your account.
param(
  [string]$Name = "village-demo-triage",
  [ValidateSet("private", "public")][string]$Visibility = "private"
)
$ErrorActionPreference = "Stop"

$village = Split-Path -Parent $PSScriptRoot
$target = Join-Path (Split-Path -Parent $village) $Name
if (Test-Path $target) { throw "$target already exists. Pick another -Name, or delete that folder yourself first." }

Copy-Item -Recurse (Join-Path $PSScriptRoot "triage-target") $target
Push-Location $target
try {
  git init -b main | Out-Null
  git add -A
  git commit -q -m "Initial triage module"
  if ($LASTEXITCODE -ne 0) { throw "git commit failed (is user.name / user.email set?)" }

  npm test
  if ($LASTEXITCODE -ne 0) { throw "the seed tests failed; not creating the GitHub repo" }

  gh repo create $Name "--$Visibility" --source . --remote origin --push
  if ($LASTEXITCODE -ne 0) { throw "gh repo create failed" }

  $issues = @(
    @{ title = "Refer submissions above the underwriter's TIV authority limit"; file = "1-tiv-authority.md" },
    @{ title = "Decline submissions from sanctioned territories"; file = "2-sanctioned-territory.md" },
    @{ title = "Make triage smarter"; file = "3-not-ready.md" }
  )
  foreach ($i in $issues) {
    gh issue create --title $i.title --body-file (Join-Path $PSScriptRoot "issues\$($i.file)")
    if ($LASTEXITCODE -ne 0) { throw "gh issue create failed for $($i.file)" }
  }

  Write-Host ""
  Write-Host "Target ready at $target"
  Write-Host "Try:  npm run village -- work 3 --repo $target            (input gate, costs nothing)"
  Write-Host "      npm run village -- work 1 --repo $target --verify `"npm test`" --max-usd 1"
}
finally {
  Pop-Location
}
