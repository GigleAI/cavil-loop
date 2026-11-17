#!/usr/bin/env bash
# 流程标签改名（GitHub#569）的共用规则：哪些设置能改名、新名字能写成什么、记录文件在哪。
# _lib.sh（daemon 各入口、scripts/label-rename.sh）和 scripts/project-config.sh 都 source 这一份，
# 不各写一套。只定义，不执行任何东西。

# 能改名的流程标签：一个设置一个名字的那几项（「也算派工的标签」这类逗号列表不在里面）
LABEL_RENAME_FIELDS="LABEL_PENDING_AGENT LABEL_PENDING_AGENT_FABLE LABEL_AGENT_DOING LABEL_PENDING_HUMAN LABEL_PENDING_PR LABEL_DONE LABEL_PENDING_REVIEW LABEL_AUTOPILOT LABEL_PENDING_MERGE LABEL_PENDING_BLOCKED LABEL_PENDING_LATER LABEL_PENDING_REQUESTER_BOT"
# 按标签历史判断的几项：有打开的条目挂着时不让改名（GitHub 的事件记录改名后记哪个名字没实测）
LABEL_RENAME_HISTORY_FIELDS="LABEL_AUTOPILOT LABEL_PENDING_MERGE LABEL_PENDING_BLOCKED LABEL_PENDING_REQUESTER_BOT"
# 配置里会写标签名的其他设置：改名前确认它们没用到新旧两个名字（逗号列表按元素比）
LABEL_RENAME_LIST_FIELDS="LABEL_PENDING_AGENT_EXTRA GREEDY_SKIP_LABELS PRIORITY_LABELS"

label_rename_field_ok() {   # <设置名>
    case " $LABEL_RENAME_FIELDS " in *" $1 "*) return 0 ;; esac
    return 1
}
# 新名字：字母、数字和 . _ : / @ + -，1–50 个字符。GitHub 上限 50；配置那一行能原样写下的字符本来就只有
# 这些（project-config.sh 的 LIT_CHARS），再去掉逗号——逗号在列表类设置里是分隔符
label_rename_name_ok() {   # <名字>
    [ "${#1}" -ge 1 ] && [ "${#1}" -le 50 ] && [[ "$1" =~ ^[A-Za-z0-9._:/@+-]+$ ]]
}
label_rename_record_path() { printf '%s/label-rename.json\n' "$1"; }   # <状态目录>
label_watch_path() { printf '%s/label-watch.json\n' "$1"; }            # <状态目录>

# ── 配置改写计数（GitHub#569）──
# 本工具自己改配置的唯一入口是 project-config.sh set（窗口保存、标签改名都走它）。它在换上新文件之前把这个
# 计数推到奇数、换上之后再推到偶数；每个读配置的进程在加载之前读一次，拿到轮询锁后再读一次——两次一样且是
# 偶数，才说明这期间本工具没改过配置（label_rename_gate）。按配置文件的真实位置分开记，和保存用的锁同一个目录。
# 只协调本工具自己的写入：人在编辑器里直接改配置不经过这里（和项目配置窗口的说明一致）。
config_gen_path() {   # <配置文件真实位置>
    local h
    if command -v sha256sum >/dev/null 2>&1; then h="$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then h="$(printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1)"
    else return 1; fi
    printf '%s/config-locks/%s.gen\n' "$CAVIL_STATE_HOME" "$h"
}
# 读计数：文件不在 = 0（从没被本工具改过）；读到非数字 = 输出 bad（当成「改写中 / 读不了」）
config_gen_read() {   # <配置文件真实位置>
    local f v
    f="$(config_gen_path "$1")" || { printf 'bad'; return 0; }
    if [ ! -e "$f" ] && [ ! -L "$f" ]; then printf '0'; return 0; fi
    v="$(cat "$f" 2>/dev/null || true)"
    case "$v" in ''|*[!0-9]*) printf 'bad' ;; *) printf '%s' "$v" ;; esac
}
# 改写开始 / 结束：开始时把计数推到下一个奇数，结束时推到下一个偶数（不管原来停在哪——上次没收尾的奇数也能
# 被下一次保存带回偶数）。写临时文件再改名；失败返回 1（调用方决定是否继续）
config_gen_set() {   # <配置文件真实位置> <odd|even>
    local f v tmp
    f="$(config_gen_path "$1")" || return 1
    v="$(config_gen_read "$1")"
    [ "$v" != bad ] || v=0
    v=$((v + 1))
    if [ "$2" = odd ]; then [ $((v % 2)) = 1 ] || v=$((v + 1)); else [ $((v % 2)) = 0 ] || v=$((v + 1)); fi
    mkdir -p "$(dirname "$f")" 2>/dev/null || return 1
    tmp="$f.tmp.$$"
    printf '%s\n' "$v" > "$tmp" 2>/dev/null && mv -f "$tmp" "$f" 2>/dev/null
}
