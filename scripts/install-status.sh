#!/usr/bin/env bash
# 只读：一次读全本机 cavil-loop 的状态，输出一个 JSON 对象（GitHub#313）。
#
# 用法：
#   bash scripts/install-status.sh                 # 本机全部状态
#   bash scripts/install-status.sh --agent codex   # 另外按 codex 判断依赖缺项（接新项目前的预检）
#
# 不写任何文件、不改任何后台任务；可以随时跑。输出字段见 docs/operations.md
# 「Machine-readable status」一节。几条硬规则：
#   · 调度器状态只认已知状态词，读失败 / 空输出一律是 "unknown"（读不到），绝不报 "stopped"；
#   · 依赖清单和 setup.sh 是同一个函数（scripts/_install.sh 的 cavil_agent_deps），结论一致；
#   · 新旧两套名字都看（scripts/_names.sh），改名前的旧安装同样列出，同一个实例名两边都有时新的赢。
# 退出码：0 = 输出了 JSON；1 = 用法错误或缺 jq（JSON 都拼不出来）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=_names.sh
source "$SCRIPT_DIR/_names.sh"
# shellcheck source=_install.sh
source "$SCRIPT_DIR/_install.sh"

CHECK_AGENT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --agent) CHECK_AGENT="${2:-}"; [ -n "$CHECK_AGENT" ] || { echo "--agent 后面要跟 agent 名" >&2; exit 1; }; shift 2 ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "不认识的参数：$1" >&2; exit 1 ;;
    esac
done
command -v jq >/dev/null 2>&1 || { echo "缺 jq，拼不出 JSON" >&2; exit 1; }

OS="$(uname -s 2>/dev/null || true)"
case "$OS" in
    Linux)  SCHEDULER=systemd ;;
    Darwin) SCHEDULER=launchd ;;
    *)      SCHEDULER="" ;;
esac

# JSON 数组：jq -n '$ARGS.positional' --args ...（空数组也成立）
json_list() { jq -cn '$ARGS.positional' --args "$@"; }
json_str_or_null() { if [ -n "$1" ]; then jq -cn --arg v "$1" '$v'; else printf 'null'; fi; }

# ── daemon 本体：装在哪、哪个版本、什么形态 ──
DEPLOY_ROOT="${CAVIL_DEPLOY_ROOT:-$HOME/.agents/releases/cavil-loop}"
entry="$(cavil_skill_link)"
target=""; form=missing; version=""
if [ -e "$entry" ]; then
    target="$(cd "$entry" 2>/dev/null && pwd -P || true)"
    case "$target" in
        "$DEPLOY_ROOT/releases/"*)
            form=managed
            version="$(basename "$target")" ;;
        "")
            form=unknown ;;
        *)
            if git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
                form=checkout
                version="$(git -C "$target" rev-parse HEAD 2>/dev/null || true)"
            else
                form=directory
            fi ;;
    esac
elif [ -L "$entry" ]; then
    form=dangling
fi
daemon_json="$(jq -cn --arg entry "$entry" --argjson target "$(json_str_or_null "$target")" \
    --arg form "$form" --argjson version "$(json_str_or_null "$version")" \
    --arg script_dir "$SKILL_DIR" \
    '{entry:$entry, target:$target, form:$form, version:$version, script_dir:$script_dir}')"

# ── gh 登录 ──
if command -v gh >/dev/null 2>&1; then
    if gh auth status >/dev/null 2>&1; then gh_json='{"installed":true,"logged_in":true}'
    else gh_json='{"installed":true,"logged_in":false}'; fi
else
    gh_json='{"installed":false,"logged_in":null}'
fi

# ── 不含 agent 的通用依赖 ──
base_missing=()
while IFS= read -r c; do
    command -v "$c" >/dev/null 2>&1 || base_missing+=("$c")
done < <(cavil_required_cmds "$OS")
base_json="$(json_list ${base_missing[@]+"${base_missing[@]}"})"

# ── 后台任务会用哪个 bash（和 setup.sh 写进后台任务的是同一个函数）──
# 低于 4 的（macOS 自带的 3.2）没有 associative array，daemon 跑不起来；macOS 上要 `brew install bash`。
# 读不出版本 = ok 为 null（读不到），不当成「够用」。
bash_bin="$(cavil_bash_bin "$OS")"
bash_major="$("$bash_bin" -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null || true)"
case "$bash_major" in ''|*[!0-9]*) bash_major="" ;; esac
bash_json="$(jq -cn --arg path "$bash_bin" --arg m "$bash_major" \
    '{path:$path, major:(if $m == "" then null else ($m|tonumber) end),
      ok:(if $m == "" then null else (($m|tonumber) >= 4) end)}')"

# agent_json <角色> <agent> <项目根> <是否必需 true|false> <何时需要>
agent_json() {
    local role="$1" agent="$2" root="$3" required="$4" when="$5" state
    if cavil_agent_deps "$SKILL_DIR" "$root" "$agent" "$OS" 2>/dev/null; then
        if [ ${#CAVIL_DEPS_MISSING[@]} -eq 0 ]; then state=ok; else state=missing; fi
        jq -cn --arg role "$role" --arg agent "$agent" --arg bin "$CAVIL_AGENT_BIN" --arg state "$state" \
            --argjson required "$required" --arg when "$when" \
            --argjson missing "$(json_list ${CAVIL_DEPS_MISSING[@]+"${CAVIL_DEPS_MISSING[@]}"})" \
            '{role:$role, agent:$agent, bin:$bin, state:$state, required:$required, needed_when:$when, missing:$missing}'
    else
        jq -cn --arg role "$role" --arg agent "$agent" --argjson required "$required" --arg when "$when" \
            '{role:$role, agent:$agent, bin:null, state:"no_driver", required:$required, needed_when:$when, missing:[]}'
    fi
}

agent_check_json=null
if [ -n "$CHECK_AGENT" ]; then
    agent_check_json="$(agent_json check "$CHECK_AGENT" "" true "")"
fi

# ── 环境文件（KEY=VALUE，无引号无展开）里取一个值 ──
env_value() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -1; }

# ── 在子 shell 里 source 项目配置，NUL 分隔输出要的几个值 ──
# 和 setup.sh 的 config_value 同一种读法：配置里写成 "$HOME/..." 的值能展开，
# 注释里的同名字样不会被当成赋值。source 失败 = 配置读不出（rc 非 0）。
read_config() {   # <配置文件> <项目根>
    ( set +eu; set -a
      PROJECT_ROOT="$2"
      . "$1" >/dev/null 2>&1 || exit 3
      printf '%s\0' "${REPO:-}" "${STATE_DIR:-}" "${WORKER_AGENT:-claude}" \
          "${LABEL_PENDING_REVIEW:-}" "${REVIEW_WORKER_AGENT:-codex}" \
          "${LABEL_PENDING_AGENT_FABLE:-pending/agent/fable}" "${FABLE_WORKER_AGENT:-claude}" )
}

# ── 上次轮询时间：节奏状态里的 last_poll（真跑过 GitHub 的那一轮），没有就看 poll.log 的修改时间 ──
last_poll_json() {   # <STATE_DIR>
    local sd="$1" lp="" src=""
    if [ -n "$sd" ] && [ -f "$sd/poll-pace.json" ]; then
        lp="$(jq -r '.last_poll // empty' "$sd/poll-pace.json" 2>/dev/null || true)"
        case "$lp" in ''|*[!0-9]*) lp="" ;; *) src=poll-pace ;; esac
    fi
    if [ -z "$lp" ] && [ -n "$sd" ] && [ -f "$sd/poll.log" ]; then
        lp="$(date -r "$sd/poll.log" +%s 2>/dev/null || true)"
        case "$lp" in ''|*[!0-9]*) lp="" ;; *) src=poll-log ;; esac
    fi
    if [ -n "$lp" ]; then
        jq -cn --argjson e "$lp" --arg s "$src" '{epoch:$e, iso:($e|todate), source:$s}'
    else
        printf 'null'
    fi
}

# ── 每个已接项目 ──
projects=()
seen_keys=" "
for env_file in "$CAVIL_CONFIG_HOME"/*.conf "$CAVIL_LEGACY_CONFIG_HOME"/*.conf; do
    [ -f "$env_file" ] || continue
    key="$(basename "$env_file" .conf)"
    [ "$key" = deploy ] && continue                  # 部署器自己的共享配置，不是项目
    case "$seen_keys" in *" $key "*) continue ;; esac  # 新旧两边都有：新的赢（_names.sh 的规则）
    [ "$(cavil_project_env "$key")" = "$env_file" ] || continue
    seen_keys="$seen_keys$key "
    layout="$(cavil_layout_of_env "$env_file")"
    host="$(env_value "$env_file" PROJECT_ROOT)"
    config="$(env_value "$env_file" CODING_AGENT_CONFIG)"

    repo=""; state_dir=""; config_state=unreadable; agents=()
    vals=()
    if [ -n "$config" ] && [ -f "$config" ] && [ -r "$config" ]; then
        while IFS= read -r -d '' v; do vals+=("$v"); done < <(read_config "$config" "$host" || true)
    fi
    if [ ${#vals[@]} -eq 7 ]; then
        config_state=ok
        repo="${vals[0]}"; state_dir="${vals[1]}"
        agents+=("$(agent_json worker "${vals[2]}" "$host" true "")")
        # 复审 agent：只在配了复审标签（功能开着）时算必需
        if [ -n "${vals[3]}" ]; then
            agents+=("$(agent_json review "${vals[4]}" "$host" true "")")
        fi
        # 按标签选模型（fable 标签）：标签总有默认值，功能一直在；但只在有人打了这个标签时才会起，
        # 所以列出来、不算进项目的「缺什么」——不然一个 codex 项目会因为没装 claude 被报成缺依赖。
        agents+=("$(agent_json fable "${vals[6]}" "$host" false "label:${vals[5]}")")
    fi

    sched_json=null
    case "$SCHEDULER" in
        systemd)
            unit="$(cavil_systemd_timer "$layout" "$key")"
            cavil_systemd_probe "$unit"
            sched_json="$(jq -cn --arg kind systemd --arg unit "$unit" --arg state "$CAVIL_SCHED_STATE" --arg raw "$CAVIL_SCHED_RAW" \
                '{kind:$kind, unit:$unit, state:$state, raw:$raw}')" ;;
        launchd)
            label="$(cavil_launchd_label "$layout" "$key")"
            plist="$HOME/Library/LaunchAgents/$label.plist"
            cavil_launchd_probe "$label"
            case "$CAVIL_SCHED_STATE" in loaded) st=running ;; unloaded) st=stopped ;; *) st=unknown ;; esac
            sched_json="$(jq -cn --arg kind launchd --arg unit "$label" --arg state "$st" --arg raw "$CAVIL_SCHED_RAW" \
                --arg plist "$plist" --argjson plist_exists "$([ -f "$plist" ] && echo true || echo false)" \
                '{kind:$kind, unit:$unit, state:$state, raw:$raw, plist:$plist, plist_exists:$plist_exists}')" ;;
    esac

    if [ ${#agents[@]} -gt 0 ]; then
        agents_json="$(printf '%s\n' "${agents[@]}" | jq -cs '.')"
    else
        agents_json=null
    fi
    projects+=("$(jq -cn --arg key "$key" --arg layout "$layout" --arg env_file "$env_file" \
        --argjson host "$(json_str_or_null "$host")" --argjson config "$(json_str_or_null "$config")" \
        --arg config_state "$config_state" --argjson repo "$(json_str_or_null "$repo")" \
        --argjson state_dir "$(json_str_or_null "$state_dir")" --argjson agents "$agents_json" \
        --argjson scheduler "$sched_json" --argjson last_poll "$(last_poll_json "$state_dir")" '
        {key:$key, layout:$layout, env_file:$env_file, host:$host, config:$config,
         config_state:$config_state, repo:$repo, state_dir:$state_dir, agents:$agents,
         deps: (if $agents == null then {state:"unknown", missing:null}
                else ([$agents[] | select(.required)]) as $req
                  | if any($req[]; .state == "no_driver") then {state:"unknown", missing:([$req[].missing[]] | unique)}
                    else ([$req[].missing[]] | unique) as $m
                      | {state:(if ($m|length) == 0 then "ok" else "missing" end), missing:$m} end end),
         scheduler:$scheduler, last_poll:$last_poll}')")
done
if [ ${#projects[@]} -gt 0 ]; then
    projects_json="$(printf '%s\n' "${projects[@]}" | jq -cs '.')"
else
    projects_json='[]'
fi

jq -n --arg os "$OS" --argjson scheduler "$(json_str_or_null "$SCHEDULER")" \
    --argjson daemon "$daemon_json" --argjson gh "$gh_json" --argjson base "$base_json" --argjson bash "$bash_json" \
    --argjson agent_check "$agent_check_json" --argjson projects "$projects_json" '
    {version:1, os:$os, scheduler:$scheduler, daemon:$daemon, gh:$gh,
     base_deps:{missing:$base}, bash:$bash, agent_check:$agent_check, projects:$projects}'
