# shellcheck shell=bash
# Splitting one test file into parts (GitHub#211). Sourced by test files, never run on its own.
#
# A file declares how many parts it has with one header line (read by tests/run.sh too):
#
#     # parts: 3
#
# tests/run.sh then schedules each part as its own unit, running the file with TEST_PART=K/N; `--verify`
# requires every part to pass exactly once. Run by hand without TEST_PART the file runs every part,
# exactly as before it was split.
#
# Inside the file:
#   part_on K     → true when part K runs in this process (always true without TEST_PART).
#                   Wrap each part's positive cases in `if part_on K; then … fi`.
#
# A TEST_PART that does not match the declared count, or a malformed one, stops the file with exit 2:
# running the wrong slice and passing would be a silent hole.

PARTS_N=1
PARTS_K=0      # 0 = no TEST_PART: run everything

parts_init() {   # [file] (default: $0)
    local file="${1:-$0}" declared
    declared=$(sed -n 's/^# parts: *\([0-9][0-9]*\) *$/\1/p' "$file" | head -1)
    PARTS_N="${declared:-1}"
    [ -n "${TEST_PART:-}" ] || return 0
    if ! [[ "$TEST_PART" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]]; then
        echo "TEST_PART 应为 K/N，实得 [$TEST_PART]" >&2; exit 2
    fi
    if [ "${BASH_REMATCH[2]}" != "$PARTS_N" ] || [ "${BASH_REMATCH[1]}" -gt "$PARTS_N" ]; then
        echo "TEST_PART=$TEST_PART 与文件头声明的 parts: $PARTS_N 不符（$(basename "$file")）" >&2; exit 2
    fi
    PARTS_K="${BASH_REMATCH[1]}"
    echo "（本次只跑第 $PARTS_K / $PARTS_N 段）"
}

part_on() { [ "$PARTS_K" = 0 ] || [ "$PARTS_K" = "$1" ]; }

parts_init "${BASH_SOURCE[1]:-$0}"
