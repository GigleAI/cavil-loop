# shellcheck shell=bash
# Where a dispatch script writes its prompt, for tests (GitHub#396). Sourced by test files.
#
# The dispatch scripts write the prompt into the project's own state directory
# ($STATE_DIR/prompts/, see prompt_file_path in scripts/_lib.sh). Before that they wrote fixed
# names under /tmp, keyed by item number only; tests use fixed item numbers, so two copies of a
# test running at once read or deleted each other's prompts. Tests that also run the scripts as
# they were at the merge-base would still hit that while the merge-base is an old version, so
# every tree a test runs goes through prompt_tree_isolate first:
#
#   prompt_tree_isolate <root> <dir>       old-style tree: point its three /tmp prompt names at
#                                          <dir> (a directory of this test run); new-style: nothing.
#                                          Anything in between (one script has it, another does not,
#                                          or one has it twice) is an error — never fall back to /tmp.
#   prompt_file_of <root> <state dir> new <N>
#   prompt_file_of <root> <state dir> cmt <N> <comment id>
#   prompt_file_of <root> <state dir> pr  <PR>
#                                          the file that tree's dispatch writes. For a PR the work
#                                          number is found by name (<N>-pr-<PR>.md); none or several
#                                          → prints the would-be pattern, which does not exist.
#   prompt_files_clear <root> <state dir>  remove every prompt that tree may have written for this
#                                          run (only this run's directories, never /tmp).
#
# Only the file location is changed in an old tree: the line that builds the file name. What the
# script writes into it, and everything else it does, stays byte for byte as it was.

PROMPT_TREE_MARK=.cavil-test-legacy-prompt-dir
PROMPT_TREE_SCRIPTS="dispatch-new-issue.sh dispatch-issue-comment.sh dispatch-pr-comment.sh"

prompt_tree_isolate() {   # <root> <dir>
    local root="$1" dir="$2" s n have=0 none=0 c
    for s in $PROMPT_TREE_SCRIPTS; do
        [ -f "$root/scripts/$s" ] || { echo "prompt_tree_isolate: $root/scripts/$s 不存在" >&2; return 1; }
        n=$(grep -c '"/tmp/cavil-loop-' "$root/scripts/$s" || true)
        case "$n" in
            0) none=$((none + 1)) ;;
            1) have=$((have + 1)) ;;
            *) echo "prompt_tree_isolate: $root/scripts/$s 里固定的 /tmp 提示词路径有 $n 处（应为 1）" >&2; return 1 ;;
        esac
    done
    if [ "$none" = 3 ]; then
        # 新写法，或者已经改写过（改写过的留着记号，不再动）
        if [ -f "$root/$PROMPT_TREE_MARK" ]; then
            [ "$(head -1 "$root/$PROMPT_TREE_MARK")" = "$dir" ] && return 0
            echo "prompt_tree_isolate: $root 已经改写到 $(head -1 "$root/$PROMPT_TREE_MARK")，不能再改到 $dir" >&2
            return 1
        fi
        return 0
    fi
    if [ "$have" != 3 ]; then
        echo "prompt_tree_isolate: $root 三个派工脚本里只有 $have 个写固定的 /tmp 提示词路径，认不出是哪种写法" >&2
        return 1
    fi
    case "$dir" in
        /*) ;;
        *) echo "prompt_tree_isolate: 目录要写绝对路径：$dir" >&2; return 1 ;;
    esac
    case "$dir" in
        *'|'*|*'&'*|*'\'*) echo "prompt_tree_isolate: 目录名里有 sed 用的字符：$dir" >&2; return 1 ;;
    esac
    mkdir -p "$dir" || return 1
    for s in $PROMPT_TREE_SCRIPTS; do
        sed -i "s|\"/tmp/cavil-loop-|\"$dir/cavil-loop-|" "$root/scripts/$s" || return 1
        c=$(grep -c '"/tmp/cavil-loop-' "$root/scripts/$s" || true)
        n=$(grep -cF "\"$dir/cavil-loop-" "$root/scripts/$s" || true)
        if [ "$c" != 0 ] || [ "$n" != 1 ]; then
            echo "prompt_tree_isolate: 改写 $root/scripts/$s 后核对不对（/tmp 还剩 $c 处，新目录 $n 处）" >&2
            return 1
        fi
    done
    printf '%s\n' "$dir" > "$root/$PROMPT_TREE_MARK"
}

_prompt_legacy_dir() {   # <root> → the directory, or nothing for a new-style tree
    [ -f "$1/$PROMPT_TREE_MARK" ] && head -1 "$1/$PROMPT_TREE_MARK"
}

prompt_file_of() {   # <root> <state dir> <new|cmt|pr> <N | PR> [comment id]
    local root="$1" state="$2" kind="$3" a="$4" b="${5:-}" legacy f
    local -a hits
    legacy="$(_prompt_legacy_dir "$root")"
    if [ -n "$legacy" ]; then
        case "$kind" in
            new) printf '%s/cavil-loop-issue-%s-prompt.md\n' "$legacy" "$a" ;;
            cmt) printf '%s/cavil-loop-issue-%s-cmt-%s.md\n' "$legacy" "$a" "$b" ;;
            pr)  printf '%s/cavil-loop-pr-%s-prompt.md\n' "$legacy" "$a" ;;
            *)   return 2 ;;
        esac
        return 0
    fi
    case "$kind" in
        new) printf '%s/prompts/%s-new.md\n' "$state" "$a" ;;
        cmt) printf '%s/prompts/%s-cmt-%s.md\n' "$state" "$a" "$b" ;;
        pr)
            hits=()
            for f in "$state/prompts/"*"-pr-$a.md"; do [ -e "$f" ] && hits+=("$f"); done
            if [ "${#hits[@]}" = 1 ]; then printf '%s\n' "${hits[0]}"
            else printf '%s/prompts/*-pr-%s.md\n' "$state" "$a"; fi ;;
        *) return 2 ;;
    esac
}

prompt_files_clear() {   # <root> <state dir>
    local legacy
    legacy="$(_prompt_legacy_dir "$1")"
    if [ -n "$legacy" ]; then rm -f "$legacy"/cavil-loop-*.md
    else rm -f "$2"/prompts/*.md; fi
}
