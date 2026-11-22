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
   `EXIT` trap（改用 tmux_sandbox_on_exit）；每个 `env -i` 都要带 `TMUX_TMPDIR=`。
4. 任何测试文件里用绝对路径直接调 tmux（`/usr/bin/tmux ls`）都报：它绕过沙盒的包装。

管不到（写在 AGENTS.md）：经变量或包装函数调用的 tmux（`"$REAL_TMUX" …`、`T()`）、
只经被测脚本间接用 tmux 的测试、here-doc 里写出去再执行的脚本。

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


def code_lines(text):
    """(行号, 行) —— 去掉注释行和 here-doc 正文。"""
    out = []
    end = None
    for no, line in enumerate(text.splitlines(), 1):
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
            if re.search(r"\benv\s+-i\b", line) and "TMUX_TMPDIR=" not in line:
                problems.append((no, "env -i 没带 TMUX_TMPDIR=，子进程会连到别的 tmux 服务"))
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
