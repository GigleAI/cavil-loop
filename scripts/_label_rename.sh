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

