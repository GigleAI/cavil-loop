#!/usr/bin/env bash
# Cut a release tag: release/vYYYY.MM.DD.N
#
# Computes today's UTC date + the next sequence number for today, creates the
# tag at the local HEAD of main, and pushes it. The Release workflow
# (.github/workflows/release.yml) does the rest.
#
# Usage:
#   bash scripts/release.sh            # interactive, asks before pushing
#   bash scripts/release.sh --dry-run  # print the tag that would be created, do nothing
set -euo pipefail

DRY_RUN=false
case "${1:-}" in
    --dry-run) DRY_RUN=true ;;
    "" ) ;;
    * ) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
    echo "❌ not on main (current: $branch)" >&2
    exit 1
fi

if ! git diff --quiet HEAD || [ -n "$(git status --porcelain)" ]; then
    echo "❌ working tree dirty — commit or stash first" >&2
    exit 1
fi

git fetch origin main --tags --quiet

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [ "$local_sha" != "$remote_sha" ]; then
    echo "❌ local main not in sync with origin/main" >&2
    echo "   local:  $local_sha" >&2
    echo "   remote: $remote_sha" >&2
    exit 1
fi

today="$(date -u +%Y.%m.%d)"

max_n=0
while IFS= read -r tag; do
    [ -z "$tag" ] && continue
    n="${tag##*.}"
    if [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt "$max_n" ]; then
        max_n="$n"
    fi
done < <(git tag -l "release/v${today}.*")

next_n=$((max_n + 1))
tag="release/v${today}.${next_n}"

echo "Will create tag:  $tag"
echo "  pointing at:    $local_sha"
echo "  commit subject: $(git log -1 --pretty='%s' HEAD)"

if $DRY_RUN; then
    echo "(dry-run, not tagging)"
    exit 0
fi

read -rp "Proceed? [y/N] " yn
case "$yn" in
    y|Y|yes)
        git tag "$tag"
        git push origin "$tag"
        echo "✓ pushed $tag"
        if command -v gh >/dev/null 2>&1; then
            repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
            [ -n "$repo" ] && echo "  watch: https://github.com/$repo/actions"
        fi
        ;;
    *)
        echo "aborted"
        exit 1
        ;;
esac
