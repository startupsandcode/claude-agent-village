#!/usr/bin/env bash
# Creates the demo target repo next to this village checkout, pushes it to your GitHub account,
# and files the three demo issues (TIV authority, sanctioned territory, not ready).
#
#   demo/setup-target.sh                         # private repo named village-demo-triage
#   demo/setup-target.sh triage-live public
#   demo/setup-target.sh --yes                   # no prompt when reusing an existing GitHub repo
#
# Run it again after demo/cleanup-target.sh. If the GitHub repo already exists, setup reuses it:
# it force-pushes a fresh main, closes open PRs from village/* branches and deletes those branches,
# and reuses the demo issues by title (reopened, body refreshed), filing only the missing ones.
# It asks first unless you pass --yes.
#
# Needs git, gh (logged in: gh auth status) and Node 20+.
set -euo pipefail

name="village-demo-triage"
visibility="private"
yes=0
pos=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) yes=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *)
      pos=$((pos + 1))
      if [ "$pos" = 1 ]; then name="$arg"; elif [ "$pos" = 2 ]; then visibility="$arg"; else echo "too many arguments" >&2; exit 2; fi
      ;;
  esac
done
case "$visibility" in private|public) ;; *) echo "visibility must be private or public" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
village="$(dirname "$here")"
target="$(dirname "$village")/$name"
if [ -e "$target" ]; then
  echo "$target already exists. Remove it first:  demo/cleanup-target.sh $name" >&2
  exit 1
fi

existing=0
slug=""
if gh repo view "$name" --json name >/dev/null 2>&1; then
  existing=1
  slug="$(gh repo view "$name" --json nameWithOwner --jq .nameWithOwner)"
  echo "GitHub repo $slug already exists. Setup will reuse it:"
  echo "  - force-push a fresh main (the old history on main is replaced)"
  echo "  - close open PRs from village/* branches and delete those branches"
  echo "  - reuse the three demo issues by title (reopen, refresh the body), file any that are missing"
  if [ "$visibility" != "private" ]; then echo "  (visibility is left as it is on GitHub)"; fi
  if [ "$yes" != 1 ]; then
    printf 'Continue? [y/N] '
    read -r answer || answer=""
    case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled, nothing changed."; exit 1 ;; esac
  fi
fi

cp -R "$here/triage-target" "$target"
cd "$target"
git init -q -b main
git add -A
git commit -q -m "Initial triage module"
npm test

if [ "$existing" = 0 ]; then
  gh repo create "$name" "--$visibility" --source . --remote origin --push
else
  if [ "$(gh config get git_protocol -h github.com 2>/dev/null || true)" = "ssh" ]; then
    url="$(gh repo view "$slug" --json sshUrl --jq .sshUrl)"
  else
    url="$(gh repo view "$slug" --json url --jq .url).git"
  fi
  git remote add origin "$url"
  git push -q --force -u origin main

  for pr in $(gh pr list --state open --limit 100 --json number,headRefName \
      --jq '.[] | select(.headRefName | startswith("village/")) | .number'); do
    gh pr close "$pr" --comment "Closed by demo/setup-target.sh: the demo target was reset."
  done
  for ref in $(git ls-remote --heads origin 'refs/heads/village/*' | awk '{print $2}'); do
    git push -q origin --delete "${ref#refs/heads/}"
  done
fi

# Prints the issue number for a title, reusing an existing issue (lowest number) when there is one.
ensure_issue() {
  local title="$1" file="$2" num="" state="" n s t
  while IFS=$'\t' read -r n s t; do
    if [ "$t" = "$title" ] && { [ -z "$num" ] || [ "$n" -lt "$num" ]; }; then num="$n"; state="$s"; fi
  done < <(gh issue list --state all --limit 200 --json number,state,title \
             --jq '.[] | "\(.number)\t\(.state)\t\(.title)"')
  if [ -z "$num" ]; then
    gh issue create --title "$title" --body-file "$file" | sed -E 's#.*/issues/([0-9]+).*#\1#'
  else
    if [ "$state" = "CLOSED" ]; then gh issue reopen "$num" >/dev/null; fi
    gh issue edit "$num" --body-file "$file" >/dev/null
    echo "$num"
  fi
}

tiv="$(ensure_issue "Refer submissions above the underwriter's TIV authority limit" "$here/issues/1-tiv-authority.md")"
sanc="$(ensure_issue "Decline submissions from sanctioned territories" "$here/issues/2-sanctioned-territory.md")"
vague="$(ensure_issue "Make triage smarter" "$here/issues/3-not-ready.md")"

echo
echo "Target ready at $target"
echo "Issues: #$tiv TIV authority, #$sanc sanctioned territory, #$vague not ready"
echo "Try:  npm run village -- work $vague --repo $target            (input gate, costs nothing)"
echo "      npm run village -- work $tiv --repo $target --verify \"npm test\" --max-usd 1"
