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
#   bash scripts/release.sh --pending  # the weekly workflow's plan step: same checks as
#                                      # --auto, tags nothing; stdout = the tag --auto would
#                                      # cut (exit 0) or the tag already on the commit (exit 3)
#   ... --auto --at <sha> / --pending --at <sha>
#                                      # act on <sha> instead of HEAD: the commit the release
#                                      # gate tested (GitHub#195). It must be main's tip or an
#                                      # ancestor of it; main may have moved on meanwhile.
#   bash scripts/release.sh --title <tag>
#                                      # print the Release title: the tag plus the
#                                      # Monday–Sunday iteration its date falls in
#   bash scripts/release.sh --plan --trigger schedule|manual --released <file>
#                                      # the Release workflow's plan step (GitHub#309):
#                                      # decides, once, what this run does for the week
#                                      # that just ended. <file> = every tag that has a
#                                      # Release page, one per line (read by the caller;
#                                      # a failed read must fail the caller). stdout =
#                                      # action= (new | page | none), sha=, tag=, week=, reason=
#                                      # "main's tip" is origin/main as fetched here; the
#                                      # checkout may be behind it (GitHub#329: a queued run
#                                      # is checked out on the commit that triggered it), and
#                                      # the same goes for --cut. A checkout beside main is refused.
#   bash scripts/release.sh --cut <tag> --at <sha> [--page]
#                                      # the release step: tag <sha> as <tag> exactly as
#                                      # planned (stdout = the tag). Exit 3 = <tag> already
#                                      # points at <sha> (its page may still be missing);
#                                      # <tag> on another commit → exit 1. --page: the plan
#                                      # said "create the missing page" — never tags.
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

# The iteration that just ended (GitHub#309): iterations run Monday–Sunday in Beijing time
# (UTC+8), so at any moment the latest finished one is the one whose Sunday is the Beijing
# date minus its ISO weekday (Sunday 23:59 → the previous Sunday; Monday 00:10 → yesterday).
# Prints YYYY.MM.DD. CAVIL_RELEASE_NOW (epoch seconds) stands in for the clock in tests.
week_end() {
    local now="${CAVIL_RELEASE_NOW:-}" bj dow
    if [ -z "$now" ]; then now="$(date -u +%s)" || return 2; fi
    [[ "$now" =~ ^[0-9]+$ ]] || { echo "❌ CAVIL_RELEASE_NOW is not epoch seconds: $now" >&2; return 2; }
    bj=$((now + 8 * 3600))
    dow="$(date -u -d "@$bj" +%u)" || return 2
    date -u -d "@$((bj - dow * 86400))" +%Y.%m.%d
}
TAG_SHAPE='^release/v[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$'

# The release tags as the remote has them right now: "<tag> <commit>" per line, annotated tags
# peeled to their commit. --plan and --cut decide from this, never from local tags — a plain
# `git fetch --tags` keeps a local tag the remote has since deleted (GitHub#309 review). A
# failed listing returns 1; the caller must stop, never read it as "no tags".
remote_release_tags() {
    local raw
    if ! raw="$(git ls-remote --tags origin 'refs/tags/release/v*')"; then
        echo "❌ cannot list the remote's release tags" >&2
        return 1
    fi
    awk '{ n = $2; sub(/^refs\/tags\//, "", n)
           if (n ~ /\^\{\}$/) { sub(/\^\{\}$/, "", n); peeled[n] = $1 } else plain[n] = $1 }
         END { for (n in plain) print n, ((n in peeled) ? peeled[n] : plain[n]) }' <<<"$raw"
}

usage() { echo "usage: $0 [--dry-run | --auto [--at <sha>] | --pending [--at <sha>] | --title <tag> | --plan --trigger schedule|manual --released <file> | --cut <tag> --at <sha> [--page]]" >&2; exit 2; }
DRY_RUN=false
AUTO=false
PENDING=false
PLAN=false
CUT=""
PAGE=false
TRIGGER=""
RELEASED_FILE=""
AT=""
case "${1:-}" in
    --dry-run) DRY_RUN=true; [ $# -eq 1 ] || usage ;;
    --auto|--pending)
        [ "$1" = --auto ] && AUTO=true || PENDING=true
        case $# in
            1) ;;
            3) [ "$2" = --at ] && [ -n "$3" ] || usage; AT="$3" ;;
            *) usage ;;
        esac
        ;;
    --title)
        [ $# -eq 2 ] || { echo "usage: $0 --title <tag>" >&2; exit 2; }
        release_title "$2"
        exit
        ;;
    --plan)
        PLAN=true; shift
        while [ $# -gt 0 ]; do
            case "$1" in
                --trigger) [ $# -ge 2 ] || usage; TRIGGER="$2"; shift 2 ;;
                --released) [ $# -ge 2 ] || usage; RELEASED_FILE="$2"; shift 2 ;;
                *) usage ;;
            esac
        done
        case "$TRIGGER" in schedule|manual) ;; *) usage ;; esac
        [ -n "$RELEASED_FILE" ] || usage
        ;;
    --cut)
        [ $# -ge 4 ] && [ -n "$2" ] && [ "$3" = --at ] && [ -n "$4" ] || usage
        CUT="$2"; AT="$4"
        case $# in
            4) ;;
            5) [ "$5" = --page ] || usage; PAGE=true ;;
            *) usage ;;
        esac
        [[ "$CUT" =~ $TAG_SHAPE ]] || { echo "❌ not a release tag: $CUT" >&2; exit 2; }
        ;;
    "" ) ;;
    * ) usage ;;
esac

# Every non-interactive mode keeps stdout for its answer alone, so the workflow can capture it.
if $AUTO || $PENDING || $PLAN || [ -n "$CUT" ]; then exec 3>&1 1>&2; fi

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
if $PLAN || [ -n "$CUT" ]; then
    # The Release workflow's two steps (GitHub#329). An Actions job checks out the commit
    # the run was triggered on, and main moves on while the run waits in the queue or the
    # gate runs for hours — so here the checkout may be behind main, never beside it.
    # main's tip is read once, by the fetch above; everything below uses that one value.
    rc=0; git merge-base --is-ancestor "$local_sha" "$remote_sha" || rc=$?
    case "$rc" in
        0) ;;
        1)  echo "❌ this checkout is not on origin/main's history" >&2
            echo "   local:  $local_sha" >&2
            echo "   remote: $remote_sha" >&2
            exit 1 ;;
        *)  echo "❌ cannot tell whether this checkout ($local_sha) is on origin/main ($remote_sha)" >&2
            exit 1 ;;
    esac
elif [ "$local_sha" != "$remote_sha" ]; then
    echo "❌ local main not in sync with origin/main" >&2
    echo "   local:  $local_sha" >&2
    echo "   remote: $remote_sha" >&2
    exit 1
fi

# What gets tagged: HEAD — for --plan main's tip as just read, which the checkout may be
# behind — or with --at the commit the release gate tested. That commit has to be on main
# (its tip or an ancestor); anything else is refused.
target="$local_sha"
if $PLAN; then target="$remote_sha"; fi
if [ -n "$AT" ]; then
    if ! target="$(git rev-parse -q --verify "${AT}^{commit}")"; then
        echo "❌ --at $AT is not a commit here" >&2
        exit 1
    fi
    if ! git merge-base --is-ancestor "$target" "$remote_sha"; then
        echo "❌ --at $target is not on main (origin/main = $remote_sha)" >&2
        exit 1
    fi
fi

if [ -n "$CUT" ]; then
    # Exactly the planned tag on exactly the planned commit — no date or number is worked
    # out here, so a run that started on Sunday night and tags on Monday still names the
    # week it planned for. Checked right before writing: the tag must not exist yet, or
    # (for a page the plan said is missing) must still point at the planned commit.
    tags_now="$(remote_release_tags)" || exit 1
    existing="$(awk -v t="$CUT" '$1 == t { print $2 }' <<<"$tags_now")"
    if [ -n "$existing" ]; then
        if [ "$existing" = "$target" ]; then
            echo "$CUT already points at $target — no new tag"
            echo "$CUT" >&3
            exit 3
        fi
        echo "❌ $CUT already exists on $existing, not on the planned $target" >&2
        exit 1
    fi
    if $PAGE; then
        echo "❌ $CUT was planned as a tag without its Release page, but the remote no longer has it" >&2
        exit 1
    fi
    if git rev-parse -q --verify "refs/tags/$CUT" >/dev/null; then
        echo "❌ $CUT exists here but not on the remote — not guessing which is right" >&2
        exit 1
    fi
    git tag "$CUT" "$target"
    git push origin "$CUT"
    echo "✓ pushed $CUT → $target"
    echo "$CUT" >&3
    exit 0
fi

if $PLAN; then
    # One decision for the scheduled run and a manual release (GitHub#309), first match wins:
    #   1. a tag on main's tip has no Release page  → page: that tag, its commit
    #   2. a tag of the week that just ended has none → page: the highest such tag, its commit
    #   3. main's tip is tagged and every tag on it has its page → none
    #   4. the week already has a released tag: schedule → none; manual → new, next number
    #   5. otherwise → new: release/v<week>.<next number> on main's tip
    # A missing page always comes first, so a tag whose page failed is never stranded by
    # "this week is already released". Anything unreadable fails the run, never guesses.
    [ -f "$RELEASED_FILE" ] && [ -r "$RELEASED_FILE" ] || { echo "❌ cannot read the Release list $RELEASED_FILE" >&2; exit 1; }
    week="$(week_end)" || exit 2
    has_page() {  # 0 = has a page, 1 = has none; a read error stops the run
        local rc=0
        grep -qxF -- "$1" "$RELEASED_FILE" || rc=$?
        case "$rc" in
            0|1) return "$rc" ;;
            *) echo "❌ cannot read the Release list $RELEASED_FILE" >&2; exit 1 ;;
        esac
    }
    emit() {  # <action> <sha> <tag> <reason>
        echo "$4"
        printf 'action=%s\nsha=%s\ntag=%s\nweek=%s\nreason=%s\n' "$1" "$2" "$3" "$week" "$4" >&3
        exit 0
    }
    # Every read below is checked: a failed tag listing, Release list or ancestry check stops
    # the run with no plan — never "no tags", "no page" or "not on main".
    tags_now="$(remote_release_tags)" || exit 1
    head_tags=(); week_tags=()
    while read -r t c; do
        [[ "$t" =~ $TAG_SHAPE ]] || continue
        [ "$c" = "$target" ] && head_tags+=("$t")
        [[ "$t" == "release/v${week}."* ]] && week_tags+=("$t $c")
    done <<<"$tags_now"
    if [ "${#head_tags[@]}" -gt 0 ]; then mapfile -t head_tags < <(printf '%s\n' "${head_tags[@]}" | sort -rV); fi
    if [ "${#week_tags[@]}" -gt 0 ]; then mapfile -t week_tags < <(printf '%s\n' "${week_tags[@]}" | sort -rV); fi
    for t in "${head_tags[@]}"; do
        has_page "$t" || emit page "$target" "$t" "$t 已有 tag 但还没有 Release 页面，先跑发版门禁再补建"
    done
    for tc in "${week_tags[@]}"; do
        t="${tc% *}"; c="${tc#* }"
        if ! has_page "$t"; then
            rc=0; git merge-base --is-ancestor "$c" "$remote_sha" || rc=$?
            case "$rc" in
                0) ;;
                1) echo "❌ $t points at $c, which is not on main" >&2; exit 1 ;;
                *) echo "❌ cannot tell whether $t ($c) is on main" >&2; exit 1 ;;
            esac
            emit page "$c" "$t" "$t（$c）已有 tag 但还没有 Release 页面，先跑发版门禁再补建"
        fi
    done
    if [ "${#head_tags[@]}" -gt 0 ]; then
        emit none "$target" "" "本轮无新提交，不发版（${head_tags[0]} 已发布）"
    fi
    max_n=0
    for tc in "${week_tags[@]}"; do t="${tc% *}"; n="${t##*.}"; [ "$n" -gt "$max_n" ] && max_n="$n"; done
    if [ "$max_n" -gt 0 ] && [ "$TRIGGER" = schedule ]; then
        emit none "$target" "" "迭代 $week 已发布（${week_tags[0]% *}），本轮不发版"
    fi
    tag="release/v${week}.$((max_n + 1))"
    emit new "$target" "$tag" "将发新版 $tag（$target），先跑发版门禁"
fi

# A tag is not a published release: the Release page may have failed after the
# push. So --auto only reports the existing tag; the caller decides whether the
# page still has to be created.
released="$(git tag --points-at "$target" -l 'release/v*' --sort=-v:refname | head -n1)"
if [ -n "$released" ] && { $AUTO || $PENDING; }; then
    echo "$target is already tagged $released — no new tag"
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
echo "  pointing at:    $target"
echo "  commit subject: $(git log -1 --pretty='%s' "$target")"

if $DRY_RUN; then
    echo "(dry-run, not tagging)"
    exit 0
fi

if $PENDING; then
    echo "(pending: a new tag would be cut, nothing tagged)"
    echo "$tag" >&3
    exit 0
fi

if $AUTO; then
    git tag "$tag" "$target"
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
