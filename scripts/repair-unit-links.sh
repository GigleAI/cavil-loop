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

# What is at <path>, following symlinks: "dir", "other" (exists, not a dir),
# "absent" (confirmed: the lookup said no such file), or "unknown" (anything
# else — a parent we may not traverse, a symlink loop, …). `[ -e ]` / `[ -d ]`
# cannot tell "absent" from "could not look" (PR #111 review round 2: a
# non-traversable parent made the unit dir look absent and the deployer deleted
# a release two timer links still pointed into), so every existence decision in
# this file goes through here.
_ul_state() {
    local err
    if [ -d "$1" ]; then echo dir; return; fi
    if [ -e "$1" ]; then echo other; return; fi
    err="$(LC_ALL=C stat -L -- "$1" 2>&1 >/dev/null)"
    case "$err" in
        *"No such file or directory"*|*"Not a directory"*) echo absent ;;
        *) echo unknown ;;
    esac
}

# THE one listing of the unit dir, used by the repair and by the pre-delete
# check alike (PR #111 review round 1: they used to list differently — glob vs
# `find`, which does not enter a symlinked start dir). Prints every symlink in
# the unit dir and in its one-level subdirs (timers.target.wants/ …), following
# the dir and each subdir when they are symlinks.
#   returns 0 — the listing is complete (empty output: confirmed nothing there)
#   returns 1 — something on the way could not be looked at; output is partial.
# Callers that protect something treat 1 as "cannot tell".
_ul_all_links() {
    local e st rc=0 l
    case "$(_ul_state "$UL_SYS_DIR")" in
        dir) ;;
        absent) return 0 ;;
        *) return 1 ;;
    esac
    [ -r "$UL_SYS_DIR" ] && [ -x "$UL_SYS_DIR" ] || return 1
    for e in "$UL_SYS_DIR"/*; do
        [ -e "$e" ] || [ -L "$e" ] || continue      # empty dir: the glob stays literal
        [ -L "$e" ] && printf '%s\n' "$e"
        st="$(_ul_state "$e")"
        case "$st" in
            dir)
                if [ ! -r "$e" ] || [ ! -x "$e" ]; then rc=1; continue; fi
                for l in "$e"/*; do [ -L "$l" ] && printf '%s\n' "$l"; done ;;
            other|absent) ;;
            *) rc=1 ;;
        esac
    done
    return "$rc"
}

# Ours among them.
_ul_links() {
    local l
    while IFS= read -r l; do
        [ -n "$l" ] || continue
        _ul_ours "$(basename "$l")" || continue
        printf '%s\n' "$l"
    done < <(_ul_all_links || true)
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
    while IFS= read -r l; do
        n="$(basename "$l")"
        case "$n" in *@?*.timer) printf '%s\n' "$n" ;; esac
    done < <(_ul_links) | sort -u
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
    local st
    st="$(_ul_state "$UL_SYS_DIR")"
    [ "$st" = absent ] && return 0
    [ "$st" = dir ] || { _ul_log "cannot look into $UL_SYS_DIR ($st); nothing repaired this time"; return 1; }
    st="$(_ul_state "$UL_DEPLOY_ROOT")"
    [ "$st" = absent ] && return 0
    [ "$st" = dir ] || { _ul_log "cannot look into $UL_DEPLOY_ROOT ($st); nothing repaired this time"; return 1; }
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
    real="$(readlink -f "$rel" 2>/dev/null || true)"
    # Complete listing or nothing: a partial one cannot prove "no reference".
    list="$(_ul_all_links)" || return 0
    while IFS= read -r l; do
        [ -n "$l" ] || continue
        t="$(readlink "$l" 2>/dev/null)" || return 0
        # A link we cannot resolve only proves nothing when its target is
        # confirmed absent; anything else (a parent we may not enter) counts.
        if ! r="$(readlink -f "$l" 2>/dev/null)"; then
            [ "$(_ul_state "$l")" = absent ] || return 0
            r=""
        fi
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
