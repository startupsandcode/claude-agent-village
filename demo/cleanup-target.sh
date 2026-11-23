#!/usr/bin/env bash
# Removes the local demo target so demo/setup-target.sh can run again. Local only: the GitHub repo,
# its issues and PRs are left as they are (setup-target.sh reuses an existing repo).
#
#   demo/cleanup-target.sh                         # village-demo-triage, asks you to type the name
#   demo/cleanup-target.sh triage-live --yes       # no prompt
#   demo/cleanup-target.sh --archive-runs          # also move runs/ to runs-<timestamp>
#
# Deletes: <parent>/<name> and <parent>/.village-worktrees/<name>-issue-*, where <parent> is the
# folder that holds this village checkout. Never touches the village checkout itself.
set -euo pipefail

name="village-demo-triage"
yes=0
archive=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) yes=1 ;;
    --archive-runs) archive=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) name="$arg" ;;
  esac
done
case "$name" in
  ""|.|..|*/*|*\\*) echo "name must be a plain folder name, got: '$name'" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
village="$(dirname "$here")"
parent="$(dirname "$village")"
target="$parent/$name"
wtdir="$parent/.village-worktrees"

if [ "$(cd "$target" 2>/dev/null && pwd || true)" = "$village" ]; then
  echo "refusing: $target is this village checkout" >&2
  exit 1
fi
if [ -d "$target" ] && [ ! -f "$target/src/triage.js" ]; then
  echo "refusing: $target doesn't look like the demo target (no src/triage.js)" >&2
  exit 1
fi

worktrees=()
if [ -d "$wtdir" ]; then
  for d in "$wtdir/$name"-issue-*; do
    [ -d "$d" ] && worktrees+=("$d")
  done
fi
runs="$village/runs"
archived=""
if [ "$archive" = 1 ] && [ -d "$runs" ]; then
  archived="$village/runs-$(date +%Y%m%d-%H%M%S)"
fi

if [ ! -d "$target" ] && [ ${#worktrees[@]} -eq 0 ] && [ -z "$archived" ]; then
  echo "Nothing to clean up for $name."
  exit 0
fi

echo "This will delete, on this machine only:"
[ -d "$target" ] && echo "  $target"
for d in ${worktrees[@]+"${worktrees[@]}"}; do echo "  $d"; done
[ -n "$archived" ] && echo "and move $runs to $archived"
echo "The GitHub repo $name is not touched."

if [ "$yes" != 1 ]; then
  printf 'Type %s to confirm: ' "$name"
  read -r answer || answer=""
  if [ "$answer" != "$name" ]; then
    echo "Cancelled, nothing deleted."
    exit 1
  fi
fi

for d in ${worktrees[@]+"${worktrees[@]}"}; do
  if [ -d "$target/.git" ]; then
    git -C "$target" worktree remove --force "$d" 2>/dev/null || true
  fi
  rm -rf "$d"
done
rmdir "$wtdir" 2>/dev/null || true
[ -d "$target" ] && rm -rf "$target"
[ -n "$archived" ] && mv "$runs" "$archived"

suffix=""
[ "$name" != "village-demo-triage" ] && suffix=" $name"
echo "Done. Run demo/setup-target.sh$suffix to set it up again (it reuses the GitHub repo)."
