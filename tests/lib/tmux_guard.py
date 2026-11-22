"""用真 tmux 的测试必须有自己的 tmux 服务（GitHub#647）：只读文本的检查。

tests/tmux-sandbox-guard.test.sh 调用。对每个 tests/*.test.sh：

1. 找直接调用：在命令位置上出现的字面 `tmux`（行首、`;` `&&` `||` `|` `(` `$(` 之后、
   `then` / `do` / `else` / `if` / `while` / `until` / `!` / `timeout N` 之后、`trap` 那一行
   引号字符串的开头），后面跟会话 / 服务子命令，且没带 `-S` / `-L`。注释行、here-doc 正文
   不看。
2. 有这种调用的文件，必须在第一处调用之前就已隔离：source 了 tests/lib/tmux-sandbox.sh
   并调用了 tmux_sandbox_start；或者自己有 `export TMUX_TMPDIR=` 加清掉 TMUX 的写法
   （`unset … TMUX …` 或 `exec env -i` 重跑自己）。
3. source 了 tests/lib/tmux-sandbox.sh 的文件：source 之前不许有 mktemp / mkdir / trap /
   tmux 调用（载入时会重新执行本文件，之前建的东西会建两遍）；source 之后不许自己设
   `EXIT` trap（改用 tmux_sandbox_on_exit）；清理回调里不许 `rm`（删目录用
   tmux_sandbox_own_dir）；清空环境的子进程只能经 tmux_sandbox_env_i 起（规则见 env_i_problems）。
   续行（行尾反斜杠）接成一行再看。
4. 任何测试文件里用绝对路径直接调 tmux（`/usr/bin/tmux ls`）都报：它绕过沙盒的包装。

管不到（写在 AGENTS.md）：经变量或包装函数调用的 tmux（`"$REAL_TMUX" …`、`T()`）、
只经被测脚本间接用 tmux 的测试、here-doc 里写出去再执行的脚本、PATH 先被别处改掉、
子进程自己再改 PATH 或清空环境、经变量调 env。

用法：python3 tmux_guard.py <文件>...   每个问题打印一行「文件:行号: 原因」，有问题退出 1。
"""
import re
import sys

SUB = (r"(?:new-session|new|kill-session|kill-server|ls|list-sessions|has-session|has|"
       r"list-panes|list-windows|set-option|set|show-options|display-message|display|"
       r"send-keys|capture-pane|pipe-pane|split-window|start-server|attach-session|attach|"
       r"rename-session|new-window|kill-pane|respawn-pane)")
FLAGS = r"((?:-[A-Za-z]+(?:\s+(?!-)[^\s;|&()]+)?\s+)*)"
POS = (r"(?:^|[;&|(]|\$\(|!|\b(?:then|do|else|if|while|until)\b|\btimeout\s+\S+)\s*")
CALL = re.compile(POS + r"tmux\s+" + FLAGS + SUB + r"(?=$|[\s;|&)'\"])")
TRAP_CALL = re.compile(r"""['"]\s*tmux\s+""" + FLAGS + SUB + r"(?=$|[\s;|&)'\"])")
ABS_CALL = re.compile(r"(?:^|[\s;&|(])/\S*/tmux\s+" + FLAGS + SUB + r"(?=$|[\s;|&)'\"])")
HEREDOC = re.compile(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")
SANDBOX_SRC = re.compile(r"^\s*(?:source|\.)\s+.*tmux-sandbox\.sh")
SANDBOX_START = re.compile(r"(?:^|[;&|(]|\bthen\b)\s*tmux_sandbox_start\b")


# ── 清空环境的子进程（PR #660 复审 #4，第四轮改设计）────────────────────────────────
# 前三版都想从文字里看出「env -i 实际收到了哪些赋值」：先是整行搜文字，后来按引号切词，
# 每一版都被复审找出新的 shell 写法绕过（空值、注释、命令名之后、重定向之后……）。改成
# 不再判断：用沙盒的文件里，空环境子进程只能经 tests/lib/tmux-sandbox.sh 的
# tmux_sandbox_env_i 起——PATH 和 TMUX_TMPDIR 由它在运行时原样加上，调用方再给这两样就
# 拒绝（真实子进程的行为在 tests/tmux-sandbox.test.sh【18】测）。这里只管「文件里没有别的
# 写法」，而且只多报不少报：
#   - 一行里出现 env 后面跟着以 - 开头的词，就报——唯一放过的是只带若干个
#     `-u 变量名` 的写法（`env -u A -u B 命令`，它保留原环境，不清空）；
#   - `exec -c`（bash 自己清空环境再执行）也报；
#   - 写在引号里、行尾注释里的也照报（不区分），改措辞即可。
# 另外守住三样隔离变量（PR #660 复审第 5 轮：`env -u TMUX_TMPDIR` 被放过）。整个文件里，
# 不分是不是 env 那一行、在不在引号里，一律只看文字：
#   - `-u` 后面跟 PATH / TMUX_TMPDIR / TMUX / TMUX_PANE，报；`unset` 这几个名字，报；
#   - 给 TMUX_TMPDIR / TMUX / TMUX_PANE 赋值（`名字=`，含 export、命令前缀、env 参数），报——
#     这三样只由沙盒设；
#   - 给 PATH 赋值而值里没有 `$PATH` / `${PATH}`（整个换掉，包装就找不到了），报；在原值
#     前后加目录（造假 gh 等常见写法）放过。
# 看不出来的：经变量调 env（`"$ENV" -i`）、子进程自己再清空环境、经变量拼出的名字或值、
# 在原 PATH 前面加的目录里自己放了 tmux——写在 AGENTS.md。
ENV_DASH = re.compile(r"""(?:^|[\s;&|()`'"=/])env\s+-""")
ENV_U_ONLY = re.compile(r"""env(?:\s+-u\s+[A-Za-z_][A-Za-z0-9_]*)+\s+(?!-)\S""")
EXEC_C = re.compile(r"(?:^|[\s;&|(])exec\s+-[A-Za-z]*c")
ISO = r"(?:PATH|TMUX_TMPDIR|TMUX|TMUX_PANE)"
UNSET_ISO = re.compile(r"(?:-u\s+|--unset[=\s]+|\bunset\b[^;&|#]*?\s)" + ISO + r"(?![A-Za-z0-9_])")
SET_ISO = re.compile(r"""(?:^|[\s;&|(`'"])(?:TMUX_TMPDIR|TMUX|TMUX_PANE)=""")
SET_PATH = re.compile(r"""(?:^|[\s;&|(`'"])PATH=""")


def env_i_problems(line):
    out = []
    for m in ENV_DASH.finditer(line):
        at = line.index("env", m.start())
        if not ENV_U_ONLY.match(line, at):
            out.append("清空环境的子进程要用 tmux_sandbox_env_i 起（它原样带上 PATH 和 TMUX_TMPDIR），"
                       "不要直接写 env 加选项（注释、引号里写的也算）")
    if EXEC_C.search(line):
        out.append("exec -c 清空了环境，子进程会连到别的 tmux 服务；改用 tmux_sandbox_env_i")
    if UNSET_ISO.search(line):
        out.append("取消了沙盒的隔离变量（PATH / TMUX_TMPDIR / TMUX / TMUX_PANE），子进程会连到别的 tmux 服务或绕过包装")
    if SET_ISO.search(line):
        out.append("给 TMUX_TMPDIR / TMUX / TMUX_PANE 赋了值，这三样只由 tmux 沙盒设")
    for m in SET_PATH.finditer(line):
        if not re.match(r"""["']?[^\s;&|]*\$(?:PATH\b|\{PATH\})""", line[m.end():]):
            out.append("给 PATH 赋的值里没有原来的 $PATH，子进程找不到沙盒的 tmux 包装；在原值前后加目录即可")
    return out


def code_lines(text):
    """(行号, 行) —— 去掉注释行和 here-doc 正文；以反斜杠结尾的续行接成一行，记在第一行的行号上。"""
    out = []
    end = None
    pending = None   # (行号, 已接上的文字)
    for no, line in enumerate(text.splitlines(), 1):
        if pending is not None:
            line = pending[1] + " " + line.lstrip()
            no = pending[0]
            pending = None
        if end is None and line.endswith("\\") and not line.lstrip().startswith("#"):
            pending = (no, line[:-1])
            continue
        if end is not None:
            if line.strip() == end:
                end = None
            continue
        if line.lstrip().startswith("#"):
            continue
        out.append((no, line))
        m = HEREDOC.search(line)
        if m and "<<<" not in line:
            end = m.group(1)
    return out


def direct_calls(line):
    """这一行里没带 -S / -L 的直接调用个数，以及带了的个数。"""
    bare = isolated = 0
    pats = [CALL] + ([TRAP_CALL] if re.search(r"\btrap\b", line) else [])
    seen = set()
    for pat in pats:
        for m in pat.finditer(line):
            if m.start() in seen:
                continue
            seen.add(m.start())
            if re.search(r"(?:^|\s)-[A-Za-z]*[SL]\b", m.group(1)):
                isolated += 1
            else:
                bare += 1
    return bare, isolated


def check(path, text):
    problems = []
    lines = code_lines(text)
    first_call = None
    for no, line in lines:
        if ABS_CALL.search(line):
            problems.append((no, "用绝对路径直接调 tmux，绕过了沙盒的包装；写成 tmux（经 PATH）"))
        bare, _ = direct_calls(line)
        if bare and first_call is None:
            first_call = no
    src = next((no for no, line in lines if SANDBOX_SRC.search(line)), None)
    start = next((no for no, line in lines if SANDBOX_START.search(line)), None)
    if src is not None:
        for no, line in lines:
            if no >= src:
                break
            if re.search(r"\b(?:mktemp|mkdir|trap)\b", line) or sum(direct_calls(line)):
                problems.append((no, "在载入 tests/lib/tmux-sandbox.sh 之前就建东西 / 设 trap / 调 tmux"
                                     "（载入会重新执行本文件）"))
        for no, line in lines:
            if no > src and re.search(r"\btrap\b", line) and re.search(r"\bEXIT\b", line):
                problems.append((no, "载入 tmux 沙盒之后又自己设 EXIT trap；改用 tmux_sandbox_on_exit"))
            for why in env_i_problems(line):
                problems.append((no, why))
            if re.search(r"\btmux_sandbox_on_exit\b", line) and re.search(r"\brm\b", line):
                problems.append((no, "清理回调里删目录：变量可能是从环境继承的，改用 mktemp 之后的 tmux_sandbox_own_dir"))
        if start is None:
            problems.append((src, "载入了 tmux 沙盒却没调用 tmux_sandbox_start"))
    if first_call is not None:
        ok = False
        if src is not None and start is not None and src < first_call and start < first_call:
            ok = True
        else:
            before = [line for no, line in lines if no < first_call]
            exported = any(re.search(r"\bexport\s+TMUX_TMPDIR=", ln) for ln in before)
            cleared = any(re.search(r"\bunset\b[^#]*\bTMUX\b", ln) or re.search(r"\bexec\s+env\s+-i\b", ln)
                          for ln in before)
            ok = exported and cleared
        if not ok:
            problems.append((first_call, "直接调 tmux 之前没有隔离：先 source tests/lib/tmux-sandbox.sh 并"
                                         " tmux_sandbox_start（或 export TMUX_TMPDIR= 并清掉 TMUX）"))
    return ["%s:%d: %s" % (path, no, why) for no, why in sorted(set(problems))]


def main(paths):
    bad = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            bad += check(p, f.read())
    for b in bad:
        print(b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
