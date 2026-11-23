# Removes the local demo target so demo\setup-target.ps1 can run again. Local only: the GitHub repo,
# its issues and PRs are left as they are (setup-target.ps1 reuses an existing repo).
#
#   .\demo\cleanup-target.ps1                         # village-demo-triage, asks you to type the name
#   .\demo\cleanup-target.ps1 -Name triage-live -Yes  # no prompt
#   .\demo\cleanup-target.ps1 -ArchiveRuns            # also move runs\ to runs-<timestamp>
#
# Deletes: <parent>\<name> and <parent>\.village-worktrees\<name>-issue-*, where <parent> is the
# folder that holds this village checkout. Never touches the village checkout itself.
param(
  [string]$Name = "village-demo-triage",
  [switch]$Yes,
  [switch]$ArchiveRuns
)
$ErrorActionPreference = "Stop"

if ($Name -eq "" -or $Name -eq "." -or $Name -eq ".." -or $Name -match '[\\/]') {
  throw "Name must be a plain folder name, got: '$Name'"
}

$village = Split-Path -Parent $PSScriptRoot
$parent = Split-Path -Parent $village
$target = Join-Path $parent $Name
$wtdir = Join-Path $parent ".village-worktrees"

if ((Test-Path $target) -and ((Resolve-Path $target).Path -eq (Resolve-Path $village).Path)) {
  throw "Refusing: $target is this village checkout"
}
if ((Test-Path $target) -and -not (Test-Path (Join-Path $target "src\triage.js"))) {
  throw "Refusing: $target doesn't look like the demo target (no src\triage.js)"
}

$worktrees = @()
if (Test-Path $wtdir) {
  $worktrees = @(Get-ChildItem -Path $wtdir -Directory -Filter "$Name-issue-*" | ForEach-Object { $_.FullName })
}
$runs = Join-Path $village "runs"
$archived = $null
if ($ArchiveRuns -and (Test-Path $runs)) {
  $archived = Join-Path $village ("runs-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}

if (-not (Test-Path $target) -and $worktrees.Count -eq 0 -and -not $archived) {
  Write-Host "Nothing to clean up for $Name."
  exit 0
}

Write-Host "This will delete, on this machine only:"
if (Test-Path $target) { Write-Host "  $target" }
foreach ($d in $worktrees) { Write-Host "  $d" }
if ($archived) { Write-Host "and move $runs to $archived" }
Write-Host "The GitHub repo $Name is not touched."

if (-not $Yes) {
  $answer = Read-Host "Type $Name to confirm"
  if ($answer -ne $Name) {
    Write-Host "Cancelled, nothing deleted."
    exit 1
  }
}

foreach ($d in $worktrees) {
  if (Test-Path (Join-Path $target ".git")) {
    try { git -C $target worktree remove --force $d 2>&1 | Out-Null } catch { }
  }
  if (Test-Path $d) { Remove-Item -Recurse -Force $d }
}
if ((Test-Path $wtdir) -and -not (Get-ChildItem -Force $wtdir)) { Remove-Item -Force $wtdir }
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
if ($archived) { Move-Item $runs $archived }

$suffix = if ($Name -ne "village-demo-triage") { " -Name $Name" } else { "" }
Write-Host "Done. Run .\demo\setup-target.ps1$suffix to set it up again (it reuses the GitHub repo)."
