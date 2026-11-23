#!/usr/bin/env bash
# Creates the demo target repo next to this village checkout, pushes it to your GitHub account,
# and files the three demo issues (#1 TIV authority, #2 sanctioned territory, #3 not ready).
#
#   demo/setup-target.sh                         # private repo named village-demo-triage
#   demo/setup-target.sh triage-live public
#
# Needs git, gh (logged in: gh auth status) and Node 20+. Creates a repo on your account.
set -euo pipefail

name="${1:-village-demo-triage}"
visibility="${2:-private}"
case "$visibility" in private|public) ;; *) echo "visibility must be private or public" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
village="$(dirname "$here")"
target="$(dirname "$village")/$name"
if [ -e "$target" ]; then
  echo "$target already exists. Pick another name, or delete that folder yourself first." >&2
  exit 1
fi

cp -R "$here/triage-target" "$target"
cd "$target"
git init -q -b main
git add -A
git commit -q -m "Initial triage module"
npm test
gh repo create "$name" "--$visibility" --source . --remote origin --push

gh issue create --title "Refer submissions above the underwriter's TIV authority limit" --body-file "$here/issues/1-tiv-authority.md"
gh issue create --title "Decline submissions from sanctioned territories" --body-file "$here/issues/2-sanctioned-territory.md"
gh issue create --title "Make triage smarter" --body-file "$here/issues/3-not-ready.md"

echo
echo "Target ready at $target"
echo "Try:  npm run village -- work 3 --repo $target            (input gate, costs nothing)"
echo "      npm run village -- work 1 --repo $target --verify \"npm test\" --max-usd 1"
