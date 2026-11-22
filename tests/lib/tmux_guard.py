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
   tmux_sandbox_own_dir）；每个 `env -i` 都按 env_i_problems 的规则看（见那里）。
   续行（行尾反斜杠）接成一行再看。
4. 任何测试文件里用绝对路径直接调 tmux（`/usr/bin/tmux ls`）都报：它绕过沙盒的包装。

管不到（写在 AGENTS.md）：经变量或包装函数调用的 tmux（`"$REAL_TMUX" …`、`T()`）、
只经被测脚本间接用 tmux 的测试、here-doc 里写出去再执行的脚本、PATH 先被别处改掉再
原样传、子进程自己再改 PATH、`env -i` 的参数由展开得来（`"$@"`、`${X:+$X}`）时其中
赋了什么。

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


# ── env -i 的参数（PR #660 复审 #4，第三轮收口）─────────────────────────────────────
# 用沙盒的文件里，清空环境的子进程必须原样拿到两样：TMUX_TMPDIR（连本次运行的专用服务）
# 和 PATH（找到沙盒的 tmux 包装）。不再在整行里搜文字，而是把 `env -i` 之后的参数按 shell
# 的引号规则切成词，只看命令名之前的那些赋值参数——env 真正放进子进程环境的就是它们：
#   - 只认一种写法：`TMUX_TMPDIR="$TMUX_TMPDIR"` / `TMUX_TMPDIR="${TMUX_TMPDIR}"`，
#     `PATH="$PATH"` / `PATH="${PATH}"`，整个词就是这样（双引号、不拼别的、不带默认值）；
#   - 两样都要有；同一个名字在赋值参数里出现几次，每次都得是这种写法（后面的会盖掉前面的）；
#   - 命令名之后、注释（词首的 #）里、引号里出现的不算；
#   - 词里有展开、看不出赋的是哪个变量的（`"$1=$2"`），报；切词失败（引号没配对）也报。
# 多报不少报：`PATH=$PATH`（不加引号）、`"${TMUX_TMPDIR:-}"` 实际效果一样，也报，改成上面的写法。
# 看不出来的：参数由展开得来时（`"$@"`、`${X:+$X}`）其中赋了什么——写在 AGENTS.md。
ENV_I = re.compile(r"(?:^|[\s;&|(])env\s+-i\b")
NAME_EQ = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=")
WANT = {
    "PATH": ('PATH="$PATH"', 'PATH="${PATH}"'),
    "TMUX_TMPDIR": ('TMUX_TMPDIR="$TMUX_TMPDIR"', 'TMUX_TMPDIR="${TMUX_TMPDIR}"'),
}
ENV_OPT_ARG = {"-u", "--unset", "-C", "--chdir"}
ENV_OPT = {"-i", "--ignore-environment", "-", "-0", "--null", "-v", "--debug"}


def shell_words(text):
    """按 shell 的引号规则切词，到第一个不在引号里的命令分隔符（; & | ) < > 换行）或注释
    （词首的 #）为止。返回原样的词（引号保留）；引号或 $( ) 没配对返回 None。"""
    words, cur, i, n = [], "", 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t":
            if cur:
                words.append(cur)
                cur = ""
            i += 1
            continue
        if c in ";&|)<>\n":
            break
        if c == "#" and not cur:
            break
        if c == "\\":
            cur += text[i:i + 2]
            i += 2
            continue
        if c == "'":
            j = text.find("'", i + 1)
            if j < 0:
                return None
            cur += text[i:j + 1]
            i = j + 1
            continue
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                return None
            cur += text[i:j + 1]
            i = j + 1
            continue
        if text.startswith("$(", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                j += 1
            if depth:
                return None
            cur += text[i:j]
            i = j
            continue
        cur += c
        i += 1
    if cur:
        words.append(cur)
    return words


def unquoted(word):
    return re.sub(r"""["']""", "", word)


def env_i_problems(line):
    out = []
    for m in ENV_I.finditer(line):
        start = line.index("env", m.start())
        words = shell_words(line[start:])
        if words is None:
            out.append("env -i 这一行切不出参数（引号没配对，或写在引号里）；写成一行普通的 env -i 命令")
            continue
        i = 1
        while i < len(words) and words[i].startswith("-"):
            if words[i] in ENV_OPT_ARG:
                i += 2
            elif words[i] in ENV_OPT:
                i += 1
            elif words[i] == "--":
                i += 1
                break
            else:
                out.append("env -i 带了看不懂的选项 %s" % words[i])
                break
        seen = {k: [] for k in WANT}
        while i < len(words):
            w = words[i]
            mm = NAME_EQ.match(unquoted(w))
            if not mm:
                # 不是赋值就是命令名；等号之前就有展开的，看不出赋的是哪个变量
                if "=" in w and "$" in w.split("=", 1)[0]:
                    out.append("env -i 的参数 %s 由展开得来，看不出赋的是哪个变量" % w)
                break
            name = mm.group(1)
            if name in seen:
                seen[name].append(w)
            i += 1
        for name, forms in WANT.items():
            got = seen[name]
            if not got:
                out.append("env -i 的赋值参数里没有 %s（只认 %s），子进程%s" % (
                    name, forms[0], "会连到别的 tmux 服务" if name == "TMUX_TMPDIR" else "会绕过沙盒的 tmux 包装"))
            for w in got:
                if w not in forms:
                    out.append("env -i 的 %s 没原样传过去：写的是 %s，只认 %s" % (name, w, forms[0]))
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
