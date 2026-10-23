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
#   bash scripts/release.sh --auto     # non-interactive (the weekly workflow run):
#                                      # stdout = the pushed tag only, messages on stderr;
#                                      # exit 3 = HEAD already tagged, stdout = that tag
#                                      # (its Release page may still be missing)
#   bash scripts/release.sh --title <tag>
#                                      # print the Release title: the tag plus the
#                                      # Monday–Sunday iteration its date falls in
set -euo pipefail

# Iterations run Monday–Sunday (GitHub Project "cavil project", 7 days, start
# day Monday). The weekly run fires Sunday 16:10 UTC = Monday 00:10 Beijing, so
# the tag's UTC date is the iteration's last day.
release_title() {
    local tag="$1" d dow start end
    if [[ ! "$tag" =~ ^release/v([0-9]{4})\.([0-9]{2})\.([0-9]{2})\.[0-9]+$ ]]; then
        echo "❌ not a release tag: $tag" >&2
        return 2
    fi
    d="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
    dow="$(date -u -d "$d" +%u)" || return 2
    start="$(date -u -d "$d -$((dow - 1)) days" +%Y-%m-%d)"
    end="$(date -u -d "$start +6 days" +%Y-%m-%d)"
    [ "${start%%-*}" = "${end%%-*}" ] && end="${end#*-}"
    printf '%s · 迭代 %s ~ %s\n' "$tag" "$start" "$end"
}

DRY_RUN=false
AUTO=false
case "${1:-}" in
    --dry-run) DRY_RUN=true ;;
    --auto) AUTO=true ;;
    --title)
        [ $# -eq 2 ] || { echo "usage: $0 --title <tag>" >&2; exit 2; }
        release_title "$2"
        exit
        ;;
    "" ) ;;
    * ) echo "usage: $0 [--dry-run | --auto | --title <tag>]" >&2; exit 2 ;;
esac

# --auto keeps stdout for the tag name alone, so the workflow can capture it.
$AUTO && exec 3>&1 1>&2

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

# A tag is not a published release: the Release page may have failed after the
# push. So --auto only reports the existing tag; the caller decides whether the
# page still has to be created.
released="$(git tag --points-at HEAD -l 'release/v*' --sort=-v:refname | head -n1)"
if [ -n "$released" ] && $AUTO; then
    echo "HEAD $local_sha is already tagged $released — no new tag"
    echo "$released" >&3
    exit 3
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

if $AUTO; then
    git tag "$tag"
    git push origin "$tag"
    echo "✓ pushed $tag"
    echo "$tag" >&3
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
            if [ -n "$repo" ]; then echo "  watch: https://github.com/$repo/actions"; fi
        fi
        ;;
    *)
        echo "aborted"
        exit 1
        ;;
esac
