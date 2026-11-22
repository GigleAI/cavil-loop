"""tmux 沙盒收尾的第 4 步（tests/lib/tmux-sandbox.sh 调用；GitHub#647）。

结束测试进程 P 名下能看到的全部直接子进程：P 是收养人，测试起的后台进程（tmux 服务、
服务退出后留下的窗格程序、没结束的后台任务）祖先一退出就会出现在这里。

每读到一批：逐个用进程句柄打开（「进程不存在」= 已退出）、再读一次父进程号仍是 P 才
处理（变了说明原进程已退出、进程号被复用）；整批 SIGTERM，一起等最多 2 秒；还在的
SIGKILL，再一起等最多 2 秒。每一步的等待都不超过剩下的总时限。
某个进程退出后它的子进程又会被过继过来，所以循环读清单，直到连续 3 次（间隔 0.2 秒）
都读到空，总时限 10 秒。

退出码：0 = 读到空（打印「结束了 N 个进程」）；1 = 时限到了还有活着的；2 = 读清单出错。
这是尽力清理：读清单是一个个进程地读，扫描途中被过继过来的进程可能漏掉。
"""
import os
import select
import signal
import sys
import time

TIMEOUT = 10.0
EMPTY_ROUNDS = 3


def stat_of(pid):
    """(状态, 父进程号)；进程已不存在 → None。其他读取错误照常抛出。"""
    try:
        with open("/proc/%d/stat" % pid) as f:
            s = f.read()
    except (FileNotFoundError, ProcessLookupError):
        return None
    # 进程名里可能有空格和括号（tmux 服务叫 `tmux: server`），所以从最后一个 `)` 之后切分。
    fields = s[s.rindex(")") + 2:].split()
    return fields[0], int(fields[1])


def children(parent, skip):
    out = []
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        pid = int(d)
        if pid in skip:
            continue
        st = stat_of(pid)
        if st is None:
            continue
        state, ppid = st
        if ppid == parent and state != "Z":
            out.append(pid)
    return out


def budget_from_env():
    """总时限（秒）。CAVIL_TMUX_REAP_BUDGET 只给 tests/tmux-sandbox.test.sh 用：0.1–60 之外一律 10。"""
    try:
        v = float(os.environ.get("CAVIL_TMUX_REAP_BUDGET", ""))
    except ValueError:
        return TIMEOUT
    return v if 0.1 <= v <= 60 else TIMEOUT


def wait_all(fds, until):
    """等这些进程句柄退出，最多到 until（单调时钟）；返回还没退出的。
    用 poll 不用 select：select 只能等编号 1023 以下的描述符，调用方开着很多文件时
    进程句柄的编号会超过它（PR #660 复审 #6）。"""
    left = set(fds)
    if not left:
        return left
    poller = select.poll()
    for fd in left:
        poller.register(fd, select.POLLIN)
    while left:
        rest = until - time.monotonic()
        if rest <= 0:
            break
        for fd, _ in poller.poll(max(1, int(rest * 1000))):
            if fd in left:
                left.discard(fd)
                poller.unregister(fd)
    return left


def stop_batch(parent, pids, deadline):
    """整批一起停（复审 #5：不再逐个等，n 个不理 SIGTERM 的进程不会叠出 n×2 秒）：
    全部 SIGTERM → 一起等最多 2 秒 → 还在的 SIGKILL → 一起等最多 2 秒。每一步的等待
    都不超过剩下的总预算。返回发过信号的个数。"""
    fds = {}
    try:
        for pid in pids:
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            st = stat_of(pid)
            if st is None or st[1] != parent or st[0] == "Z":
                os.close(fd)
                continue
            fds[fd] = pid
        for fd in list(fds):
            try:
                signal.pidfd_send_signal(fd, signal.SIGTERM)
            except ProcessLookupError:
                pass
        left = wait_all(fds, min(time.monotonic() + 2, deadline))
        for fd in left:
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
        wait_all(left, min(time.monotonic() + 2, deadline))
        return len(fds)
    finally:
        for fd in fds:
            os.close(fd)


def main():
    parent = int(sys.argv[1])
    skip = {os.getpid()}
    if os.getppid() != parent:
        skip.add(os.getppid())   # 调用方的命令替换子 shell
    budget = budget_from_env()
    deadline = time.monotonic() + budget
    empty = 0
    stopped = 0
    try:
        while time.monotonic() < deadline:
            kids = children(parent, skip)
            if not kids:
                empty += 1
                if empty >= EMPTY_ROUNDS:
                    print("结束了 %d 个进程" % stopped)
                    return 0
                time.sleep(max(0.0, min(0.2, deadline - time.monotonic())))
                continue
            empty = 0
            stopped += stop_batch(parent, kids, deadline)
        left = children(parent, skip)
    except OSError as e:
        print("读进程清单出错：%s" % e)
        return 2
    if left:
        print("%g 秒后仍有进程：%s" % (budget, " ".join(map(str, left))))
    else:
        print("%g 秒内没读到连续 %d 次空清单" % (budget, EMPTY_ROUNDS))
    return 1


if __name__ == "__main__":
    sys.exit(main())
