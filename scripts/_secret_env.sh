#!/usr/bin/env bash
# 交给 worker 的敏感变量：是哪几个、值从哪来（GitHub#739）。
#
# 三处用同一份：_lib.sh（派工前检查、落 0600 文件）、setup.sh（装完提醒）、install-status.sh
# （状态里的 secret_env）。单独成文件是因为后两个不 source _lib.sh（它会加载项目配置、关 fd、
# 接管 stderr），而「缺不缺令牌」必须三处同一个结论——装完提示「齐了」、派工却拒绝，正是
# GitHub#739 要消灭的那种各说各话。
#
# 只定义函数，不改 shell 选项；macOS 自带的 bash 3.2 可用。

# 要交给 worker、又属于敏感的那些变量（= WORKER_PASS_ENV ∩ WORKER_SECRET_ENV，各自没设时是 GH_TOKEN），
# 一行一个。取交集：某个项目压根不透传 GH_TOKEN，就不该为它生成文件、也不该因为它没设而拒绝派工。
cavil_secret_vars() {
    local pass="${WORKER_PASS_ENV:-GH_TOKEN}" secret="${WORKER_SECRET_ENV:-GH_TOKEN}" v s
    for v in $pass; do
        for s in $secret; do
            if [ "$v" = "$s" ]; then
                echo "$v"
            fi
        done
    done
}

# 写 token（值）：WRITE_GH_TOKEN 优先，留空回落 GH_TOKEN。_lib.sh 的 gh_write_token 就是它。
cavil_write_token() {
    printf '%s' "${WRITE_GH_TOKEN:-${GH_TOKEN:-}}"
}

# 本机 gh **保存的**登录（`gh auth login` 存下的那份）的令牌——维护者在 GitHub#739 选的：项目没配令牌时
# 借用它，而不是拒绝派工。gh 认的四个环境令牌（`gh help environment`：GH_TOKEN、GITHUB_TOKEN 和两个
# 企业版的）都排在保存的登录前面，全部去掉再问：否则环境里临时放的一把会被当成「本机登录」交给
# worker，派工、装完检查、状态三处口径就分了叉。GH_CONFIG_DIR 不去掉——它就是「保存在哪」。
# 拿不到（没装 gh、没保存登录、读失败、输出为空）→ 返回 1，不输出任何东西。
cavil_gh_login_token() {
    local t
    command -v gh >/dev/null 2>&1 || return 1
    t="$(env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
        gh auth token --hostname github.com 2>/dev/null)" || return 1
    [ -n "$t" ] || return 1
    printf '%s' "$t"
}

# 取一个敏感变量交给 worker 的值。结果放进全局变量（不打印，免得调用方用 $( ) 丢掉来源）：
#   CAVIL_SECRET_VAL = 值；CAVIL_SECRET_SRC = env（配置 / 环境里写着的）| login（借用本机 gh 登录）
# 没有值 → 返回 1，两个变量都清空。
# GH_TOKEN 取写 token（双账号下是写入账号那把）——**只换值，不换名**，见 _lib.sh 的 secret_env_file。
cavil_secret_resolve() {
    local var="$1" val=""
    CAVIL_SECRET_VAL=""
    CAVIL_SECRET_SRC=""
    if [ "$var" = GH_TOKEN ]; then
        val="$(cavil_write_token)"
        if [ -n "$val" ]; then
            CAVIL_SECRET_SRC=env
        elif val="$(cavil_gh_login_token)"; then
            CAVIL_SECRET_SRC=login
        else
            val=""
        fi
    else
        eval "val=\${$var:-}"
        [ -z "$val" ] || CAVIL_SECRET_SRC=env
    fi
    [ -n "$val" ] || return 1
    CAVIL_SECRET_VAL="$val"
    return 0
}

# 装完 / 查状态时用：按后台真正启动时看得到的来源判断——启动配置文件（systemd 的 EnvironmentFile，
# launchd 的 plist 也是 source 它）+ 项目配置，在一个只带 HOME 的干净子进程里读，**不看调用方自己
# 环境里的值**（跑 setup 的终端里临时 export 的 GH_TOKEN、桌面客户端自己的环境，后台都拿不到）。
# PATH 照 _lib.sh 的做法在启动配置的 PATH 前面补上常见的用户目录，借用登录时找 gh 和后台一样。
#
# 每个变量输出一行：「ok <变量>」「login <变量>」（借用本机 gh 登录）「missing <变量>」，返回 0。
# 任一文件读不了 → 只输出「unreadable」，返回 2（读不到 ≠ 缺，也 ≠ 齐）。不输出任何值。
# 第三个参数 who：借用登录的那一行后面再加上账号名（`login GH_TOKEN <账号>`，问不到写 `?`）。账号是
# 拿**解析出来、真正要交给 worker 的那把令牌**去问的，和上面同一个干净环境、同一个 gh、固定
# github.com——不在调用方的环境里另猜（调用终端可能带着另一个人的令牌）。令牌经环境变量交给 gh，
# 不进命令行。要联网，所以只有 setup.sh 用；状态脚本不带它。
cavil_secret_env_check() {   # <启动配置文件> <项目配置> [who]
    local env_file="$1" config="$2" who="${3:-}" lib
    lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_secret_env.sh"
    if [ ! -r "$env_file" ] || [ ! -r "$config" ]; then
        echo unreadable
        return 2
    fi
    env -i HOME="$HOME" bash -c '
        set +eu
        set -a
        . "$1" >/dev/null 2>&1 || { echo unreadable; exit 2; }
        PATH="$HOME/.hermes/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:${PATH:-/usr/bin:/bin}"
        . "$2" >/dev/null 2>&1 || { echo unreadable; exit 2; }
        set +a
        . "$3" || { echo unreadable; exit 2; }
        cavil_secret_vars | while read -r v; do
            [ -n "$v" ] || continue
            if cavil_secret_resolve "$v"; then
                if [ "$CAVIL_SECRET_SRC" != login ]; then echo "ok $v"
                elif [ "$4" != who ]; then echo "login $v"
                else
                    a="$(GH_TOKEN="$CAVIL_SECRET_VAL" gh api --hostname github.com user --jq .login 2>/dev/null)" || a=""
                    case "$a" in ""|*[!A-Za-z0-9-]*) a="?" ;; esac
                    echo "login $v $a"
                fi
            else
                echo "missing $v"
            fi
        done
        exit 0
    ' _ "$env_file" "$config" "$lib" "$who"
}
