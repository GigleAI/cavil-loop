#!/usr/bin/env bash
# Repoint cavil-loop's systemd unit links at the stable skill entry and bring
# back timers that vanished because of it (GitHub#109).
#
#   bash repair-unit-links.sh     check + repair once (what a person runs by hand)
#   source repair-unit-links.sh   get cavil_unit_links_run / cavil_release_referenced
#
# Why this exists: `systemctl --user enable` resolves the template symlink to the
# end, so the instance link (and its timers.target.wants/ twin) points into one
# concrete releases/<sha>/ directory instead of ~/.agents/skills/cavil-loop.
# The deployer later deletes that release and the timer silently vanishes.
#
# One run, holding a machine-wide lock:
#   1. Repoint our links that point into releases/<sha>/ (live or already broken)
#      at the stable entry. A durable "reload pending" mark is written *before*
#      the first link changes; if it cannot be written, nothing is changed.
#   2. While the mark exists — whether or not this run changed anything —
#      daemon-reload. Success clears the mark; failure keeps it and stops here
#      (no starts on a failed reload). The next run reloads again.
#   3. Only with no mark left: start each of our timers that systemd reports as
#      enabled + failed with result "resources". That is exactly how systemd
#      records "unit file vanished while running" (measured on systemd 255); a
#      timer a person stopped is inactive, one they disabled is not enabled, and
#      both states survive the file coming back. Anything unreadable or
#      unexpected counts as unknown and is left alone.
#
# Every caller (poll entry each round, deployer before cleanup, setup after
# enable, legacy migration after enable) goes through cavil_unit_links_run, so
# there is one rule, not four copies.

# shellcheck source=_names.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_names.sh"

_ul_init() {
    UL_SYS_DIR="${CAVIL_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
    UL_DEPLOY_ROOT="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}"
    UL_RELEASES="$UL_DEPLOY_ROOT/releases"
    UL_SKILL="${CAVIL_SKILL_LINK:-$(cavil_skill_link)}"
    UL_MARK="$UL_DEPLOY_ROOT/.unit-reload-pending"
    UL_LOCK="$UL_DEPLOY_ROOT/.unit-links.lock"
    UL_RC=0
}

_ul_log() { printf '[repair-unit-links] %s\n' "$*" >&2; }

# Our units: new and pre-rename names (units, templates and instances, slices).
_ul_ours() {
    case "$1" in
        "$CAVIL_UNIT_PREFIX"-*|"$CAVIL_LEGACY_UNIT_PREFIX"-*|"$CAVIL_SLICE"|"$CAVIL_LEGACY_SLICE") return 0 ;;
    esac
    return 1
}

# Is this link text inside a concrete release directory? Prints the file name
# the link points to (the template, e.g. cavil-loop-poll@.timer).
_ul_release_file() {
    local t="$1" root real_root
    real_root="$(readlink -f "$UL_RELEASES" 2>/dev/null || true)"
    for root in "$UL_RELEASES" ${real_root:+"$real_root"}; do
        case "$t" in
            "$root"/*/systemd/*) printf '%s\n' "${t##*/}"; return 0 ;;
        esac
    done
    return 1
}

# Our symlinks in the unit dir and its one-level subdirs (timers.target.wants/ …).
_ul_links() {
    local l
    for l in "$UL_SYS_DIR"/* "$UL_SYS_DIR"/*/*; do
        [ -L "$l" ] || continue
        _ul_ours "$(basename "$l")" || continue
        printf '%s\n' "$l"
    done
}

_ul_repair_links() {
    local l t f new todo=() tmp
    while IFS= read -r l; do
        [ -n "$l" ] || continue
        t="$(readlink "$l")" || continue
        f="$(_ul_release_file "$t")" || continue
        new="$UL_SKILL/systemd/$f"
        if [ ! -f "$new" ]; then
            _ul_log "skip $l: the stable entry has no $f (left as is; its release stays protected)"
            UL_RC=1
            continue
        fi
        todo+=("$l|$new")
    done < <(_ul_links)
    [ "${#todo[@]}" -gt 0 ] || return 0
    # Mark first: a crash or a failed reload after the links change must still
    # leave a reason for the next run to reload.
    if ! { printf '%s\n' "$(date +%s)" > "$UL_MARK.tmp.$$" && mv -f "$UL_MARK.tmp.$$" "$UL_MARK"; } 2>/dev/null; then
        rm -f "$UL_MARK.tmp.$$" 2>/dev/null || true
        _ul_log "cannot write $UL_MARK; no link changed this time"
        UL_RC=1
        return 1
    fi
    local item
    for item in "${todo[@]}"; do
        l="${item%%|*}"; new="${item#*|}"
        tmp="$(dirname "$l")/.$(basename "$l").repair.$$"
        if ln -s "$new" "$tmp" 2>/dev/null && mv -Tf "$tmp" "$l" 2>/dev/null; then
            _ul_log "relinked $l -> $new"
        else
            rm -f "$tmp" 2>/dev/null || true
            _ul_log "relinking $l failed; it still points to $(readlink "$l" 2>/dev/null)"
            UL_RC=1
        fi
    done
}

_ul_reload() {
    [ -e "$UL_MARK" ] || return 0
    if systemctl --user daemon-reload >/dev/null 2>&1; then
        rm -f "$UL_MARK"
        _ul_log "systemd daemon-reload complete"
        return 0
    fi
    _ul_log "systemd daemon-reload failed; will retry next run, no timer started"
    UL_RC=1
    return 1
}

# Instance timers of ours that have a link anywhere in the unit dir.
_ul_timers() {
    local l n
    for l in "$UL_SYS_DIR"/*.timer "$UL_SYS_DIR"/*/*.timer; do
        [ -L "$l" ] || [ -f "$l" ] || continue
        n="$(basename "$l")"
        _ul_ours "$n" || continue
        case "$n" in *@?*.timer) printf '%s\n' "$n" ;; esac
    done | sort -u
}

_ul_start_vanished() {
    local u out k v ufs as res
    while IFS= read -r u; do
        [ -n "$u" ] || continue
        out="$(systemctl --user show -p UnitFileState -p ActiveState -p Result "$u" 2>/dev/null)" || continue
        ufs=""; as=""; res=""
        while IFS='=' read -r k v; do
            case "$k" in
                UnitFileState) ufs="$v" ;;
                ActiveState) as="$v" ;;
                Result) res="$v" ;;
            esac
        done <<< "$out"
        [ "$ufs" = enabled ] && [ "$as" = failed ] && [ "$res" = resources ] || continue
        if systemctl --user start "$u" >/dev/null 2>&1; then
            _ul_log "started $u (its unit file had vanished while it was running)"
        else
            _ul_log "starting $u failed; will retry next run"
            UL_RC=1
        fi
    done < <(_ul_timers)
}

# The one entry point. Returns 0 when everything is in order, 1 when something
# is left for the next run (always safe to call again).
cavil_unit_links_run() {
    _ul_init
    [ -d "$UL_SYS_DIR" ] || return 0
    [ -d "$UL_DEPLOY_ROOT" ] || return 0
    command -v systemctl >/dev/null 2>&1 || return 0
    local fd
    exec {fd}>>"$UL_LOCK" || { _ul_log "cannot open $UL_LOCK"; return 1; }
    if ! flock -w "${CAVIL_UNIT_LINKS_LOCK_WAIT:-30}" "$fd"; then
        _ul_log "another repair is still running; skip this time"
        eval "exec ${fd}>&-"
        return 1
    fi
    _ul_repair_links || true
    if _ul_reload; then
        _ul_start_vanished
    fi
    eval "exec ${fd}>&-"
    return "$UL_RC"
}

# Does anything in the unit dir still point into <release dir>? Returns 0 when
# referenced *or when that cannot be determined* — the deployer keeps the
# release in both cases. Checks every symlink (ours or not): deleting a target
# breaks the link whoever owns it.
cavil_release_referenced() {
    local rel="$1" real list l t r p
    _ul_init
    [ -e "$UL_SYS_DIR" ] || return 1
    real="$(readlink -f "$rel" 2>/dev/null || true)"
    list="$(find "$UL_SYS_DIR" -maxdepth 2 -type l 2>/dev/null)" || return 0
    while IFS= read -r l; do
        [ -n "$l" ] || continue
        t="$(readlink "$l" 2>/dev/null)" || return 0
        r="$(readlink -f "$l" 2>/dev/null || true)"
        for p in "$rel" ${real:+"$real"}; do
            case "$t" in "$p"/*) return 0 ;; esac
            case "$r" in "$p"/*) return 0 ;; esac
        done
    done <<< "$list"
    return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -uo pipefail
    cavil_unit_links_run
    rc=$?
    # Only for a person at a terminal: the poll entry runs this every round and
    # its journal should only carry lines when something actually happened.
    if [ "$rc" -eq 0 ] && [ -t 2 ]; then _ul_log "done: unit links point at the stable entry"; fi
    exit "$rc"
fi
