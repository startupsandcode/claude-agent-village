# Creates the demo target repo next to this village checkout, pushes it to your GitHub account,
# and files the three demo issues (TIV authority, sanctioned territory, not ready).
#
#   .\demo\setup-target.ps1                      # private repo named village-demo-triage
#   .\demo\setup-target.ps1 -Name triage-live -Visibility public
#   .\demo\setup-target.ps1 -Yes                 # no prompt when reusing an existing GitHub repo
#
# Run it again after demo\cleanup-target.ps1. If the GitHub repo already exists, setup reuses it:
# it force-pushes a fresh main, closes open PRs from village/* branches and deletes those branches,
# and reuses the demo issues by title (reopened, body refreshed), filing only the missing ones.
# It asks first unless you pass -Yes.
#
# Needs git, gh (logged in: gh auth status) and Node 20+.
param(
  [string]$Name = "village-demo-triage",
  [ValidateSet("private", "public")][string]$Visibility = "private",
  [switch]$Yes
)
$ErrorActionPreference = "Stop"

# Runs a native command without PowerShell turning its stderr into a terminating error.
function Invoke-Native([scriptblock]$Block) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Block 2>$null } finally { $ErrorActionPreference = $prev }
}

$village = Split-Path -Parent $PSScriptRoot
$target = Join-Path (Split-Path -Parent $village) $Name
if (Test-Path $target) { throw "$target already exists. Remove it first:  .\demo\cleanup-target.ps1 -Name $Name" }

$existing = $false
$slug = ""
Invoke-Native { gh repo view $Name --json name } | Out-Null
if ($LASTEXITCODE -eq 0) {
  $existing = $true
  $slug = (gh repo view $Name --json nameWithOwner --jq .nameWithOwner).Trim()
  Write-Host "GitHub repo $slug already exists. Setup will reuse it:"
  Write-Host "  - force-push a fresh main (the old history on main is replaced)"
  Write-Host "  - close open PRs from village/* branches and delete those branches"
  Write-Host "  - reuse the three demo issues by title (reopen, refresh the body), file any that are missing"
  if ($Visibility -ne "private") { Write-Host "  (visibility is left as it is on GitHub)" }
  if (-not $Yes) {
    $answer = Read-Host "Continue? [y/N]"
    if ($answer -notmatch '^(y|yes)$') { Write-Host "Cancelled, nothing changed."; exit 1 }
  }
}

Copy-Item -Recurse (Join-Path $PSScriptRoot "triage-target") $target
Push-Location $target
try {
  git init -b main | Out-Null
  git add -A
  git commit -q -m "Initial triage module"
  if ($LASTEXITCODE -ne 0) { throw "git commit failed (is user.name / user.email set?)" }

  npm test
  if ($LASTEXITCODE -ne 0) { throw "the seed tests failed; not touching GitHub" }

  if (-not $existing) {
    gh repo create $Name "--$Visibility" --source . --remote origin --push
    if ($LASTEXITCODE -ne 0) { throw "gh repo create failed" }
  }
  else {
    $proto = (Invoke-Native { gh config get git_protocol -h github.com }) -join ""
    if ($proto.Trim() -eq "ssh") { $url = (gh repo view $slug --json sshUrl --jq .sshUrl).Trim() }
    else { $url = (gh repo view $slug --json url --jq .url).Trim() + ".git" }
    git remote add origin $url
    Invoke-Native { git push -q --force -u origin main }
    if ($LASTEXITCODE -ne 0) { throw "force-push of main to $slug failed" }

    $open = gh pr list --state open --limit 100 --json number,headRefName | ConvertFrom-Json
    $prs = @($open | Where-Object { $_.headRefName -like "village/*" } | ForEach-Object { $_.number })
    foreach ($pr in $prs) {
      gh pr close $pr --comment "Closed by demo/setup-target.ps1: the demo target was reset."
      if ($LASTEXITCODE -ne 0) { throw "gh pr close $pr failed" }
    }
    $refs = Invoke-Native { git ls-remote --heads origin "refs/heads/village/*" }
    foreach ($line in @($refs | Where-Object { $_ })) {
      $branch = ($line -split "\s+")[1] -replace '^refs/heads/', ''
      Invoke-Native { git push -q origin --delete $branch }
      if ($LASTEXITCODE -ne 0) { throw "deleting remote branch $branch failed" }
    }
  }

  # Returns the issue number for a title, reusing an existing issue (lowest number) when there is one.
  function Ensure-Issue([string]$Title, [string]$File) {
    $all = gh issue list --state all --limit 200 --json number,state,title | ConvertFrom-Json
    $match = @($all | Where-Object { $_.title -eq $Title } | Sort-Object number)
    if ($match.Count -eq 0) {
      $url = gh issue create --title $Title --body-file $File
      if ($LASTEXITCODE -ne 0) { throw "gh issue create failed for $Title" }
      return [int](($url | Select-Object -Last 1) -replace '.*/issues/(\d+).*', '$1')
    }
    $n = $match[0].number
    if ($match[0].state -eq "CLOSED") { gh issue reopen $n | Out-Null }
    gh issue edit $n --body-file $File | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "gh issue edit $n failed" }
    return [int]$n
  }

  $issues = Join-Path $PSScriptRoot "issues"
  $tiv = Ensure-Issue "Refer submissions above the underwriter's TIV authority limit" (Join-Path $issues "1-tiv-authority.md")
  $sanc = Ensure-Issue "Decline submissions from sanctioned territories" (Join-Path $issues "2-sanctioned-territory.md")
  $vague = Ensure-Issue "Make triage smarter" (Join-Path $issues "3-not-ready.md")

  Write-Host ""
  Write-Host "Target ready at $target"
  Write-Host "Issues: #$tiv TIV authority, #$sanc sanctioned territory, #$vague not ready"
  Write-Host "Try:  npm run village -- work $vague --repo $target            (input gate, costs nothing)"
  Write-Host "      npm run village -- work $tiv --repo $target --verify `"npm test`" --max-usd 1"
}
finally {
  Pop-Location
}
