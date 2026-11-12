#!/usr/bin/env python3
"""GitHub 令牌脱敏：匹配规则只在这一个文件里（GitHub#342）。

三种用法，共用同一套匹配与边界规则（analyze）：

  redact_tokens.py filter
      stdin → stdout 的数据流过滤。普通输出立刻写出；只有「还可能长成令牌」的那一小段
      尾巴先压着，等它结束（遇到令牌里不会出现的字符，或输入真正关闭）再判断。

  redact_tokens.py scan --state FILE [--budget-secs N]
                        [--plain FILE]... [--plain-final FILE]...
                        [--pane-dir DIR [--live-sessions FILE]]
                        [--cwd-prefix DIR [--claude-root DIR] [--codex-root DIR]]
      原地替换一批文件：只改令牌所在的那几个字节，文件长度不变、不改名、不截断。
      扫描位置记在 --state 里，下次只扫新增部分。

  redact_tokens.py files FILE...
      整份文件一次扫完（文件末尾就是结尾），不记位置。给人工清理旧快照用。

替换后的样子：REDACTED-<令牌 sha256 前 12 位>，后面用 - 补齐到和原令牌一样长。
等长是有意的：会话记录由 agent 的 CLI 一直开着追加，改名替换会让后续写入落进被换掉的
旧文件；等长原地改只动那几个字节，读的人（周报、agent 自己续会话）任何时刻读到的都是
同样结构的一行。

认得的格式（GitHub 现行带前缀的令牌，整串最长 255）：
  gh[pousr]_ + 36–251 个字母数字
  github_pat_ + 82–244 个字母数字下划线
左边必须是令牌里不会出现的字符（或真正的开头）；紧跟在 JSON 转义（\\n、\\t、\\uXXXX）
或终端颜色控制码后面也算。右边是字符类之外的字符，或真正的结尾。
"""
import hashlib
import json
import os
import re
import sys
import time

MAX_TOKEN = 255
CTX = 64          # 判断左边界时最多往回看的字节数

FULL = re.compile(
    rb"gh[pousr]_[A-Za-z0-9]{36,251}(?![A-Za-z0-9])"
    rb"|github_pat_[A-Za-z0-9_]{82,244}(?![A-Za-z0-9_])"
)
# 缓冲末尾「还可能长成令牌」的一段：完整前缀 + 还没结束的主体，或者前缀只出现了一部分
TAIL = re.compile(
    rb"(?:github_pat_[A-Za-z0-9_]{0,244}|gh[pousr]_[A-Za-z0-9]{0,251}"
    rb"|github_pa?t?|github_?|githu?b?|git?|gh[pousr]?|g)\Z"
)
TOKEN_CHARS = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")
CSI_END = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]\Z")
HEX4 = re.compile(rb"[0-9a-fA-F]{4}\Z")

# 会话记录里用来认领记录、统计用量的字段：值里出现的串即使长得像令牌也不改
# （周报按工作目录 / 会话编号 / 请求编号认领记录，改了就认领不到）。
PROTECTED_KEYS = frozenset((
    "cwd", "sessionId", "session_id", "id", "uuid", "parentUuid", "leafUuid",
    "requestId", "request_id", "promptId", "messageId", "message_id", "call_id",
    "tool_use_id", "toolUseID", "timestamp", "model", "type", "subtype", "role",
    "name", "gitBranch", "version", "agentId", "userType", "originator",
    "cli_version", "stop_reason", "level",
))


def fingerprint(token):
    return hashlib.sha256(token).hexdigest()[:12]


def replacement(token):
    """等长替换：REDACTED-<指纹>，不够长的部分用 - 补齐。"""
    head = b"REDACTED-" + fingerprint(token).encode()
    return head + b"-" * (len(token) - len(head))


def left_ok(buf, i):
    """位置 i 能不能是一个令牌的开头。buf 里 i 之前要带着上下文（没有 = 真正的开头）。"""
    if i == 0:
        return True
    prev = buf[i - 1]
    if prev not in TOKEN_CHARS:
        return True
    # JSON / shell 转义：\n \t \r \b \f、\uXXXX 后面紧跟令牌。不数反斜杠是单是双：
    # 命令原文里的 "\nghp_…" 写进 JSON 后是两个反斜杠，同样要认。
    if prev in b"nrtbf" and i >= 2 and buf[i - 2] == 0x5C:
        return True
    if i >= 6 and buf[i - 5] == 0x75 and buf[i - 6] == 0x5C and HEX4.search(buf, i - 4, i):
        return True
    # 终端颜色 / 光标控制码（ESC [ … 字母）
    if CSI_END.search(buf, max(0, i - 32), i):
        return True
    return False


def analyze(buf, start, final):
    """在 buf[start:] 里找令牌。buf[:start] 只是左边界用的上下文。

    返回 (matches, hold)：matches 是 [(起, 止)]，都落在 [start, hold) 内；buf[hold:] 是
    末尾还可能长成令牌的一段，这次不动（final=True 时 hold == len(buf)）。
    数据流过滤和文件扫描都只走这一个函数，所以怎么切段结果都一样。
    """
    n = len(buf)
    hold = n
    if not final:
        pos = max(start, n - MAX_TOKEN - 1)
        while pos < n:
            m = TAIL.search(buf, pos)
            if not m or m.start() >= n:
                break
            if left_ok(buf, m.start()):
                hold = m.start()
                break
            pos = m.start() + 1
    matches = []
    for m in FULL.finditer(buf, start, hold):
        if left_ok(buf, m.start()):
            matches.append((m.start(), m.end()))
    return matches, hold


# ── 数据流过滤 ──────────────────────────────────────────────────────────────

def run_filter(fd_in=0, fd_out=1):
    ctx = b""
    pending = b""
    while True:
        chunk = os.read(fd_in, 65536)
        final = not chunk
        buf = ctx + pending + chunk
        start = len(ctx)
        matches, hold = analyze(buf, start, final)
        out = bytearray(buf[start:hold])
        for a, b in matches:
            out[a - start:b - start] = replacement(buf[a:b])
        if out:
            view = memoryview(out)
            while view:
                view = view[os.write(fd_out, view):]
        pending = buf[hold:]
        ctx = buf[max(0, hold - CTX):hold]
        if final:
            return 0


# ── 原地替换文件 ────────────────────────────────────────────────────────────

class Stats:
    def __init__(self):
        self.files = 0
        self.changed_files = 0
        self.replaced = 0
        self.kept = 0          # 受保护字段里的，没改
        self.fingerprints = set()
        self.errors = 0
        self.unfinished = False


def _test_pause(fd, off, new):
    """测试用同步点：先写前一半，等测试放行再写后一半（CAVIL_REDACT_TEST_PAUSE=<路径前缀>）。"""
    base = os.environ.get("CAVIL_REDACT_TEST_PAUSE")
    if not base or os.path.exists(base + ".done"):
        return False
    half = len(new) // 2
    os.pwrite(fd, new[:half], off)
    open(base + ".reached", "w").close()
    deadline = time.time() + 120
    while not os.path.exists(base + ".go") and time.time() < deadline:
        time.sleep(0.05)
    os.pwrite(fd, new[half:], off + half)
    open(base + ".done", "w").close()
    return True


def _write_match(fd, off, token, stats):
    """写之前再读一次：那几个字节还是同一个令牌才改。"""
    if os.pread(fd, len(token), off) != token:
        return
    new = replacement(token)
    if not _test_pause(fd, off, new):
        os.pwrite(fd, new, off)
    stats.replaced += 1
    stats.fingerprints.add(fingerprint(token))


def _protected_strings(obj, out):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in PROTECTED_KEYS and isinstance(v, str):
                out.append(v)
            else:
                _protected_strings(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _protected_strings(v, out)


def _line_protected(line):
    """这一行里受保护字段的值（解析不了的行没有受保护字段，按普通文字处理）。"""
    try:
        obj = json.loads(line.decode("utf-8", "replace"))
    except ValueError:
        return []
    out = []
    _protected_strings(obj, out)
    return [s.encode("utf-8", "replace") for s in out]


def scan_file(path, off, final, jsonl, stats, deadline=None, chunk_size=4 << 20):
    """从 off 起扫 path，原地替换。返回新的扫描位置（下次从这里接着扫）。

    jsonl=True：只处理已经写完的行（以换行结束），受保护字段里的串不改。
    final=True：文件末尾就是结尾（最后一段不需要结束字符）。
    """
    fd = os.open(path, os.O_RDWR)
    try:
        size = os.fstat(fd).st_size
        if off > size:
            off = 0
        before = stats.replaced
        ctx_from = max(0, off - CTX)
        carry = os.pread(fd, off - ctx_from, ctx_from)   # 左边界上下文
        start = len(carry)
        base = ctx_from          # carry[0] 在文件里的位置
        pos = off
        new_off = off
        while True:
            chunk = os.pread(fd, min(chunk_size, size - pos), pos) if pos < size else b""
            pos += len(chunk)
            at_end = pos >= size
            buf = carry + chunk
            if jsonl:
                # 只到最后一个换行为止；没写完的最后一行留给下次
                cut = buf.rfind(b"\n", start) + 1
                if cut <= start:
                    cut = start
                matches, _ = analyze(buf[:cut], start, True) if cut > start else ([], cut)
                hold = cut
                cache = {}
                for a, b in matches:
                    ls = buf.rfind(b"\n", 0, a) + 1
                    if ls not in cache:
                        le = buf.find(b"\n", b)
                        cache[ls] = _line_protected(buf[ls:le if le >= 0 else cut])
                    token = buf[a:b]
                    if any(token in p for p in cache[ls]):
                        stats.kept += 1
                        continue
                    _write_match(fd, base + a, token, stats)
            else:
                matches, hold = analyze(buf, start, final and at_end)
                for a, b in matches:
                    _write_match(fd, base + a, buf[a:b], stats)
            new_off = base + hold
            if at_end:
                break
            keep_from = max(0, hold - CTX)
            carry = buf[keep_from:]
            start = hold - keep_from
            base += keep_from
            if deadline is not None and time.time() > deadline:
                stats.unfinished = True
                break
        stats.files += 1
        if stats.replaced > before:
            stats.changed_files += 1
        return new_off
    finally:
        os.close(fd)


# ── 哪些 agent 会话记录属于本项目 ───────────────────────────────────────────

def _under(cwd, prefix):
    return bool(cwd) and (cwd == prefix or cwd.startswith(prefix.rstrip("/") + "/"))


def _claude_cwd(path, max_lines=50):
    try:
        with open(path, "rb") as fh:
            for _ in range(max_lines):
                line = fh.readline()
                if not line:
                    break
                try:
                    cwd = json.loads(line).get("cwd")
                except (ValueError, AttributeError):
                    continue
                if isinstance(cwd, str) and cwd:
                    return cwd
    except OSError:
        pass
    return None


def _codex_cwd(path):
    try:
        with open(path, "rb") as fh:
            first = fh.readline()
        cwd = (json.loads(first).get("payload") or {}).get("cwd")
        return cwd if isinstance(cwd, str) else None
    except (OSError, ValueError, AttributeError):
        return None


def _walk_jsonl(root):
    for d, _, names in os.walk(root):
        for name in names:
            if name.endswith(".jsonl"):
                yield os.path.join(d, name)


def agent_records(cwd_prefix, claude_root, codex_root, known):
    """本项目工作目录下的会话记录。归属按记录里写的工作目录判，判过的记在 known 里。

    读不出工作目录的文件这次不算（下次再看），不会被当成「是」。
    """
    out = []
    if claude_root and os.path.isdir(claude_root):
        # 目录名是工作目录把 / 和 . 换成 - 得来的：先用它粗筛（省掉打开无关项目的几千个文件），
        # 再读记录里的工作目录确认。
        # （CLI 把所有非字母数字都换成 -；本仓库的读取方只换 /。两种写法归一后再比。）
        enc = re.sub(r"[^A-Za-z0-9]", "-", cwd_prefix.rstrip("/"))
        for name in sorted(os.listdir(claude_root)):
            if not re.sub(r"[^A-Za-z0-9]", "-", name).startswith(enc):
                continue
            for path in _walk_jsonl(os.path.join(claude_root, name)):
                own = known.get(path)
                if own is None:
                    cwd = _claude_cwd(path)
                    if cwd is None:
                        continue
                    own = known[path] = _under(cwd, cwd_prefix)
                if own:
                    out.append(path)
    if codex_root and os.path.isdir(codex_root):
        for path in _walk_jsonl(codex_root):
            own = known.get(path)
            if own is None:
                cwd = _codex_cwd(path)
                if cwd is None:
                    continue
                own = known[path] = _under(cwd, cwd_prefix)
            if own:
                out.append(path)
    return out


# ── 扫描位置 ────────────────────────────────────────────────────────────────

def load_state(path):
    try:
        with open(path) as fh:
            st = json.load(fh)
        if isinstance(st, dict) and isinstance(st.get("files"), dict) and isinstance(st.get("own"), dict):
            return st
    except (OSError, ValueError):
        pass
    return {"files": {}, "own": {}}


def save_state(path, st):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w") as fh:
        json.dump(st, fh)
    os.replace(tmp, path)


def _args(argv):
    opts = {"plain": [], "plain_final": [], "rest": []}
    single = ("--state", "--budget-secs", "--pane-dir", "--live-sessions",
              "--cwd-prefix", "--claude-root", "--codex-root")
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in single:
            opts[a[2:].replace("-", "_")] = argv[i + 1]
            i += 2
        elif a == "--plain":
            opts["plain"].append(argv[i + 1])
            i += 2
        elif a == "--plain-final":
            opts["plain_final"].append(argv[i + 1])
            i += 2
        else:
            opts["rest"].append(a)
            i += 1
    return opts


def _summary(stats):
    print("files=%d changed=%d replaced=%d kept=%d errors=%d unfinished=%d fingerprints=%s" % (
        stats.files, stats.changed_files, stats.replaced, stats.kept, stats.errors,
        1 if stats.unfinished else 0, ",".join(sorted(stats.fingerprints))))


def run_scan(argv):
    o = _args(argv)
    state_path = o.get("state")
    st = load_state(state_path) if state_path else {"files": {}, "own": {}}
    budget = float(o.get("budget_secs") or 0)
    deadline = time.time() + budget if budget > 0 else None
    stats = Stats()

    jobs = []   # (路径, 是不是会话记录, 文件末尾算不算结尾)
    for p in o["plain"]:
        jobs.append((p, False, False))
    for p in o["plain_final"]:
        jobs.append((p, False, True))
    pane_dir = o.get("pane_dir")
    if pane_dir and os.path.isdir(pane_dir):
        # 窗格历史以 tmux 会话命名。只有成功读到的会话清单里确实没有它，才算写完了；
        # 没给清单（读不到）时一律当作还会写。
        live = None
        if o.get("live_sessions"):
            try:
                with open(o["live_sessions"]) as fh:
                    live = set(line.rstrip("\n") for line in fh)
            except OSError:
                live = None
        for name in sorted(os.listdir(pane_dir)):
            if name.endswith(".log"):
                done = live is not None and name[:-4] not in live
                jobs.append((os.path.join(pane_dir, name), False, done))
    if o.get("cwd_prefix"):
        for p in agent_records(o["cwd_prefix"], o.get("claude_root"), o.get("codex_root"), st["own"]):
            jobs.append((p, True, False))

    seen = set()
    for path, jsonl, final in jobs:
        if path in seen:
            continue
        seen.add(path)
        if deadline is not None and time.time() > deadline:
            stats.unfinished = True
            break
        try:
            info = os.stat(path)
        except OSError:
            continue
        rec = st["files"].get(path) or {}
        off = rec.get("off", 0) if rec.get("ino") == info.st_ino else 0
        if off == info.st_size and not final:
            continue
        if off == info.st_size and rec.get("final"):
            continue
        try:
            new_off = scan_file(path, off, final, jsonl, stats, deadline)
        except OSError as e:
            # 读不了 / 写不了：不推进扫描位置，下次再来
            stats.errors += 1
            print("error=%s: %s" % (path, e.strerror or e), file=sys.stderr)
            continue
        st["files"][path] = {"ino": info.st_ino, "off": new_off,
                             "final": bool(final and new_off == info.st_size)}
    if state_path:
        for path in [p for p in st["files"] if not os.path.exists(p)]:
            del st["files"][path]
        for path in [p for p in st["own"] if not os.path.exists(p)]:
            del st["own"][path]
        save_state(state_path, st)
    _summary(stats)
    return 0


def run_files(paths):
    stats = Stats()
    for path in paths:
        try:
            scan_file(path, 0, True, False, stats)
        except OSError as e:
            stats.errors += 1
            print("error=%s: %s" % (path, e.strerror or e), file=sys.stderr)
    _summary(stats)
    return 1 if stats.errors else 0


def main(argv):
    if len(argv) >= 2 and argv[1] == "filter":
        return run_filter()
    if len(argv) >= 2 and argv[1] == "scan":
        return run_scan(argv[2:])
    if len(argv) >= 3 and argv[1] == "files":
        return run_files(argv[2:])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
