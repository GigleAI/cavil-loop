#!/usr/bin/env python3
"""Resident runner for a fake-`gh` script (GitHub#211): one Python per test file instead of one per call.

Started by tests/lib/fake_gh_client.sh (`install`), never by hand. It compiles the fake-GitHub script
once (tests/lib/fake_github.py, tests/fixtures/requester-bot-fake-gh.py, tests/fixtures/project-auto-add-fake-gh.py
— none of them is changed for this) and, for every `gh` call, forks a child that runs **that same
code** with the caller's argv, environment and working directory, writing straight into the caller's
stdout / stderr through /proc/<caller>/fd/1 and /fd/2. Every call is still its own process, so
concurrent calls stay concurrent and every file the fake appends to is appended to the same way.

Protocol (TCP on 127.0.0.1, one connection per call; the client writes one line):

    client → "<token> <caller pid> <argc>\\n"
    server → "FALLBACK\\n"              nothing was run; the client runs the fake itself (the old way)
           | "ACK\\n" … "EXIT <code>\\n"  ran it; <code> is the fake's exit status
           | (connection closed)        after ACK, or before any reply: result unknown — the client
                                        fails with exit 70 and never re-runs the call

argv, environment and cwd are read from /proc/<caller pid>/{cmdline,environ,cwd} — byte for byte what
the caller passed to `gh`; argv is the last <argc> entries of cmdline. FALLBACK is sent only from
checks made *before* anything is run: /proc unreadable (not Linux), the caller's stdout or stderr is
not a pipe / character device (a regular file reopened through /proc would get its own offset and
could overwrite), or the fake script changed on disk since it was compiled.

Safety: binds 127.0.0.1 on a random port; a request must carry the random token from a 0600 file in
the state directory, otherwise the connection is dropped unanswered (without it any local user could
make this run the sandbox's hook scripts). Exits when the owning test process is gone or the state
directory has been removed.

Test-only switch (tests/fake-gh-server.test.sh): `--fault-file F`. When F exists and holds
`after-ack` or `after-exec`, the child serving a call dies at that point without replying further.
Without the option nothing reads any such file.
"""
import ast
import builtins
import hmac
import io
import os
import signal
import socket
import stat
import sys
import time
import traceback


# Hold none of the starting shell's descriptors (a test's flock fd kept open here would keep its lock).
os.closerange(3, 1 << 16)


def parse_args(argv):
    opts = {"isolated": False, "fault_file": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--state", "--script", "--owner", "--fault-file"):
            opts[a[2:].replace("-", "_")] = argv[i + 1]
            i += 2
        elif a == "--isolated":
            opts["isolated"] = True
            i += 1
        else:
            sys.exit("fake_gh_server: unknown argument " + a)
    for k in ("state", "script", "owner"):
        if k not in opts:
            sys.exit("fake_gh_server: --%s is required" % k)
    return opts


O = parse_args(sys.argv[1:])
STATE = O["state"]
SCRIPT = os.path.abspath(O["script"])
OWNER = int(O["owner"])
FAULT = O["fault_file"]


def script_sig():
    st = os.stat(SCRIPT)
    return (st.st_mtime_ns, st.st_size, st.st_ino)


with open(SCRIPT, "rb") as f:
    SOURCE = f.read()
SIG = script_sig()
CODE = compile(SOURCE, SCRIPT, "exec")

# Import what the script imports once, here, so each call does not pay for it again. A module that
# fails to import is left alone: the script then fails in the child exactly as it would on its own.
for node in ast.walk(ast.parse(SOURCE)):
    names = []
    if isinstance(node, ast.Import):
        names = [a.name for a in node.names]
    elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
        names = [node.module]
    for n in names:
        try:
            __import__(n)
        except Exception:
            pass
import subprocess  # noqa: E402,F401  (the fakes all shell out to jq; keep it warm even if one does not)

with open(os.path.join(STATE, "token"), "rb") as f:
    TOKEN = f.read().strip()

# How the standard streams are set up is decided once, when an interpreter starts, from its flags and
# environment (PYTHONIOENCODING, PYTHONUTF8, PYTHONUNBUFFERED, the locale variables, …). The server is
# started the way the original command starts the fake (`python3` or `python3 -I`, see
# fake_gh_client.sh), so its own streams show what the original would get — but only for the
# environment it was started with. A call whose startup-relevant variables differ is answered with
# FALLBACK and runs the old way (review round 1 of PR #221: PYTHONIOENCODING=ascii turned a failing
# call into a passing one).
STDOUT_ENC = sys.__stdout__.encoding if sys.__stdout__ else "utf-8"
STDOUT_ERRORS = sys.__stdout__.errors if sys.__stdout__ else "strict"
STDERR_ENC = sys.__stderr__.encoding if sys.__stderr__ else "utf-8"
STDERR_ERRORS = sys.__stderr__.errors if sys.__stderr__ else "backslashreplace"
UNBUFFERED = bool(getattr(sys.__stdout__, "write_through", False))   # PYTHONUNBUFFERED / -u
LOCALE_VARS = ("LC_ALL", "LC_CTYPE", "LANG")


def startup_env(env):
    """The part of an environment that changes how `python3 [-I]` sets itself up."""
    return {k: v for k, v in env.items()
            if k in LOCALE_VARS or (not O["isolated"] and k.startswith("PYTHON"))}


START_ENV = startup_env(dict(os.environ))


def recv_line(conn, limit=4096):
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = conn.recv(limit - len(buf))
        if not chunk:
            return None
        buf += chunk
        if len(buf) >= limit:
            return None
    return buf[:-1]


def proc_read(pid, name):
    with open("/proc/%d/%s" % (pid, name), "rb") as f:
        return f.read()


def fault(point):
    if not FAULT:
        return
    try:
        with open(FAULT) as f:
            want = f.read().strip()
    except OSError:
        return
    if want == point:
        os._exit(0)


def serve(conn):
    """Runs in the forked child. Never returns."""
    try:
        line = recv_line(conn)
        parts = line.split(b" ") if line is not None else []
        if len(parts) != 3 or not hmac.compare_digest(parts[0], TOKEN):
            os._exit(0)  # drop unanswered: the client treats it as "result unknown"
        pid, argc = int(parts[1]), int(parts[2])

        # ── checks before anything runs: any failure here is a provable "not run" → FALLBACK ──
        try:
            if script_sig() != SIG:
                raise OSError("script changed since it was compiled")
            cmdline = proc_read(pid, "cmdline").split(b"\0")[:-1]
            if argc < 0 or argc > len(cmdline) - 1:
                raise OSError("argc out of range")
            args = cmdline[len(cmdline) - argc:] if argc else []
            env = {}
            for kv in proc_read(pid, "environ").split(b"\0")[:-1]:
                k, sep, v = kv.partition(b"=")
                if sep:
                    env[os.fsdecode(k)] = os.fsdecode(v)
            if startup_env(env) != START_ENV:
                raise OSError("interpreter startup settings differ from the server's")
            cwd = os.readlink("/proc/%d/cwd" % pid)
            if not os.path.isdir(cwd):
                raise OSError("cwd gone")
            fds = []
            for n in (1, 2):
                path = "/proc/%d/fd/%d" % (pid, n)
                st = os.stat(path)
                if not (stat.S_ISFIFO(st.st_mode) or stat.S_ISCHR(st.st_mode)):
                    raise OSError("fd %d is not a pipe / character device" % n)
                fds.append(os.open(path, os.O_WRONLY | os.O_CLOEXEC))
        except (OSError, ValueError):
            conn.sendall(b"FALLBACK\n")
            os._exit(0)

        conn.sendall(b"ACK\n")
        fault("after-ack")

        # ── run the fake: caller's fds, env, cwd, argv ──
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.dup2(fds[0], 1)
        os.dup2(fds[1], 2)
        for fd in fds + [devnull]:
            os.close(fd)
        os.environ.clear()
        os.environ.update(env)
        time.tzset()
        os.chdir(cwd)
        sys.argv = [SCRIPT] + [os.fsdecode(a) for a in args]
        if not O["isolated"]:
            sys.path.insert(0, os.path.dirname(SCRIPT))   # what `python3 <script>` puts first
        sys.stdin = io.TextIOWrapper(io.FileIO(0, "r", closefd=False))
        sys.stdout = io.TextIOWrapper(io.BufferedWriter(io.FileIO(1, "w", closefd=False)),
                                      encoding=STDOUT_ENC, errors=STDOUT_ERRORS,
                                      line_buffering=os.isatty(1), write_through=UNBUFFERED)
        sys.stderr = io.TextIOWrapper(io.BufferedWriter(io.FileIO(2, "w", closefd=False)),
                                      encoding=STDERR_ENC, errors=STDERR_ERRORS, line_buffering=True,
                                      write_through=UNBUFFERED)
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)
        code = 0
        try:
            exec(CODE, {"__name__": "__main__", "__file__": SCRIPT, "__builtins__": builtins})
        except SystemExit as e:
            if e.code is None:
                code = 0
            elif isinstance(e.code, int):
                code = e.code
            else:
                try:
                    sys.stderr.write(str(e.code) + "\n")
                except Exception:
                    pass
                code = 1
        except BaseException:
            try:
                traceback.print_exc()
            except Exception:
                pass
            code = 1
        try:
            sys.stdout.flush()
        except BrokenPipeError:
            try:
                sys.stderr.write("Exception ignored in: <_io.TextIOWrapper name='<stdout>' mode='w' encoding='%s'>\n"
                                 "BrokenPipeError: [Errno 32] Broken pipe\n" % STDOUT_ENC)
            except Exception:
                pass
            code = 120
        except Exception:
            code = 120
        try:
            sys.stderr.flush()
        except Exception:
            pass
        # Let go of the caller's pipes before reporting, so a `$(gh …)` sees EOF as soon as gh exits.
        null = os.open(os.devnull, os.O_WRONLY)
        os.dup2(null, 1)
        os.dup2(null, 2)
        with open(os.path.join(STATE, "served"), "ab") as f:
            f.write(b"1")
        fault("after-exec")
        conn.sendall(b"EXIT %d\n" % (code & 0xFF))
    except BaseException:
        # The serving child itself broke (not the fake): leave a trace for whoever reads server.log;
        # the client sees no exit status and reports "result unknown" (exit 70).
        try:
            with open(os.path.join(STATE, "server.log"), "a") as f:
                traceback.print_exc(file=f)
        except Exception:
            pass
    os._exit(0)


def owner_alive():
    try:
        os.kill(OWNER, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return os.path.isdir(STATE)


def main():
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)  # children are reaped by the kernel
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(256)
    srv.settimeout(1.0)
    port = srv.getsockname()[1]
    tmp = os.path.join(STATE, "port.tmp")
    with open(tmp, "w") as f:
        f.write("%d\n" % port)
    with open(os.path.join(STATE, "pid"), "w") as f:
        f.write("%d\n" % os.getpid())
    os.replace(tmp, os.path.join(STATE, "port"))
    while owner_alive():
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        except InterruptedError:
            continue
        conn.settimeout(None)
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        pid = os.fork()
        if pid == 0:
            srv.close()
            serve(conn)
        conn.close()
    try:
        os.unlink(os.path.join(STATE, "port"))
    except OSError:
        pass


if __name__ == "__main__":
    main()
