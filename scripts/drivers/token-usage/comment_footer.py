#!/usr/bin/env python3
"""评论用量 footer 的生成器（GitHub#88），由 comment-footer.sh 调用。参数见那个文件头。

形状（数字示意）：

    ---
    ⏱️ 耗时：8m 0s（测试 4m 51s · AI 约 2m 30s · 其他 39s）｜模型：claude-opus-5-5 · 8.6m token · 约 $2.48
    <details><summary>细节</summary>

    - 开始 2026-10-27 08:48:16 · 完工 08:56:16
    - <项目命令给的分条文字，原样>
    - token 明细：<用量驱动的人读行，原样>
    - AI 时间是估算：……

    </details>
    <!-- agent-metrics agent=… wt=… start=… end=… wall_secs=… <驱动 --kv 原样> test_secs=… <项目字段> -->

规矩：
  · 机器记录是最后一个非空行（周报采集器只认这一行）。
  · 总览里的三段按**显示出来的整秒**相减：「其他」= 总 − 测试 − AI，最小 0。三段不重叠时
    相加恰好等于总耗时；测试和 AI 有重叠（AI 在想、测试在后台跑）时「其他」记 0，细节里说明。
  · AI 时间算不出来就写「AI 时间未知」，不写 0、也不算「其他」。
  · token 明细整行用驱动的人读输出，金额措辞、价目提醒、模型说明都在里面，这里不重写；
    总览只按机器字段给一个短说法。
  · 项目命令（配置项 COMMENT_FOOTER_EXTRA_CMD）出任何问题——没配、失败、超时、首行不对——
    footer 照常出，只是没有「测试」那段；项目字段与已有字段同名的丢掉，不覆盖核心字段。
"""
import argparse
import datetime
import math
import os
import re
import signal
import subprocess
import sys
import time

# 项目命令的超时。环境变量只给测试用（免得一个超时用例真等 30 秒），文档不宣传
EXTRA_TIMEOUT = int(os.environ.get("CAVIL_FOOTER_EXTRA_TIMEOUT") or 30)
RE_KEY = re.compile(r'^[a-z][a-z0-9_]*$')
RE_SECS = re.compile(r'^\d+(?:\.\d+)?$')


def fmt_dur(secs):
    secs = max(0, int(secs))
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def fmt_tok(n):
    """与用量驱动的 fmt 同一规则：floor 截断到一位小数，整数不带 .0。"""
    def one(x):
        return str(int(x)) if x == int(x) else str(x)
    if n >= 1000000:
        return one(math.floor(n / 100000) / 10) + "m"
    if n >= 1000:
        return one(math.floor(n / 100) / 10) + "k"
    return str(int(n))


def usd2(x):
    c = math.floor(x * 100 + 0.5)
    return f"{c // 100}.{c % 100:02d}"


def parse_kv(line):
    """`a=1 b=2` → [(a, 1), (b, 2)]，保序；不是 k=v 的片段丢掉。"""
    out = []
    for part in (line or "").split():
        k, eq, v = part.partition("=")
        if eq and k:
            out.append((k, v))
    return out


def run_driver(driver, start_epoch, kv):
    args = ["bash", driver, str(start_epoch)] + (["--kv"] if kv else [])
    try:
        r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return ""
    return (r.stdout or "").strip().splitlines()[0] if (r.stdout or "").strip() else ""


def extra_cmd_from_config(config):
    """只从项目配置里取出这一项。配置本来就是 daemon 会 source 的本机文件。"""
    if not config or not os.path.isfile(config):
        return ""
    try:
        r = subprocess.run(
            ["bash", "-c", 'set +u; . "$1" >/dev/null 2>&1; printf %s "${COMMENT_FOOTER_EXTRA_CMD:-}"',
             "_", config],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip()


def run_extra(cmd, env_add):
    """跑项目命令 → (输出文本 | None, 失败原因)。超时连同它起的子进程一起杀掉。"""
    env = dict(os.environ, **env_add)
    try:
        p = subprocess.Popen(["bash", "-c", cmd], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             stdin=subprocess.DEVNULL, env=env, text=True, start_new_session=True)
    except OSError as e:
        return None, f"起不来（{e.strerror}）"
    try:
        out, _ = p.communicate(timeout=EXTRA_TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        p.communicate()
        return None, f"超过 {EXTRA_TIMEOUT} 秒没结束"
    if p.returncode != 0:
        return None, f"退出码 {p.returncode}"
    return out, ""


def parse_extra(out):
    """项目命令输出 → (测试秒数的原文, 细节行, 机器字段) | None。

    秒数保留原文（已校验是数字）：机器记录照原文写，只有总览按整秒显示。转成浮点再格式化
    就是在序列化边界舍入（`:g` 只留六位有效数字，123.456789 → 123.457）。
    约定：第一个非空行 `test_secs=<秒>`；以 `kv ` 开头的行是机器字段；其余非空行原样进细节。
    """
    lines = [l.rstrip() for l in out.splitlines()]
    body = [l for l in lines if l.strip()]
    if not body:
        return None
    k, eq, v = body[0].strip().partition("=")
    if k != "test_secs" or not eq or not RE_SECS.match(v):
        return None
    details, kv = [], []
    for l in body[1:]:
        if l.startswith("kv "):
            kv.extend(parse_kv(l[3:]))
        else:
            details.append(l)
    return v, details, kv


def safe_value(v):
    # 进 HTML 注释的值不能带空白（采集器按空白切）、`--`（会提前结束注释）、尖括号
    return v and not re.search(r'\s|--|[<>]', v)


def models_text(kv):
    models = [m for m in kv.get("models", "").split(",") if m]
    if not models:
        return "模型未知"
    s = "模型：" + "、".join(models)
    if kv.get("model_unknown") == "yes":
        s += "；另有模型无法确认"
    return s


def cost_text(kv):
    state = kv.get("cost_state")
    if state == "none":
        return "金额未计（没有单价）"
    try:
        usd = float(kv.get("cost_usd", ""))
    except ValueError:
        return "金额未知"
    if state == "partial":
        return f"约 ${usd2(usd)}（部分用量未计价，偏低）"
    if state == "full":
        return f"约 ${usd2(usd)}"
    return "金额未知"


def render(start_ts, start_epoch, end_epoch, agent, wt, human, kv_line, extra):
    """纯函数：所有外部输入都已取好，只管排版。测试直接调它。"""
    kv_pairs = parse_kv(kv_line)
    kv = dict(kv_pairs)
    wall = max(0, int(end_epoch - start_epoch))
    notes = []

    test = None
    extra_details, extra_kv = [], []
    if extra is not None:
        if isinstance(extra, str):
            notes.append(f"- 测试统计没取到：项目命令{extra}，总览里省掉了「测试」这一段")
        else:
            test_text, extra_details, extra_kv = extra
            test_f = float(test_text)
            test = min(int(round(test_f)), wall) if test_f > 0 else None

    ai = None
    try:
        ai = min(int(round(float(kv["ai_secs"]))), wall)
    except (KeyError, ValueError):
        pass

    segs = []
    if test is not None:
        segs.append(f"测试 {fmt_dur(test)}")
    if ai is not None:
        other = wall - (test or 0) - ai
        segs.append(f"AI 约 {fmt_dur(ai)}")
        segs.append(f"其他 {fmt_dur(max(0, other))}")
        if other < 0:
            notes.append("- 测试和 AI 时间有重叠（AI 工作时测试也在跑），两段相加超过总耗时，「其他」记为 0")
    else:
        segs.append("AI 时间未知")

    usage = "token 未知"
    if kv_pairs:
        try:
            total = sum(int(kv.get(k, 0)) for k in ("in", "out", "cache_r", "cache_w"))
            usage = f"{fmt_tok(total)} token · {cost_text(kv)}"
        except ValueError:
            pass
    head = (f"⏱️ 耗时：{fmt_dur(wall)}（{' · '.join(segs)}）"
            f"｜{models_text(kv) if kv_pairs else '模型未知'} · {usage}")

    start_dt = datetime.datetime.fromtimestamp(start_epoch).astimezone()
    end_dt = datetime.datetime.fromtimestamp(end_epoch).astimezone()
    details = [f"- 开始 {start_ts} · 完工 {end_dt.strftime('%H:%M:%S')}"]
    details += extra_details
    details.append(f"- token 明细：{human}" if human else "- token 明细：未知（没找到本次的会话记录）")
    if ai is not None:
        details.append(
            f"- AI 时间是估算：{kv.get('ai_requests', '?')} 次模型请求，每次从发出请求算到最后一段回复"
            "写进会话记录，同一秒只算一次。偏差来源：含网络往返和排队等首字的时间；会话记录是写盘"
            "时刻，与真实收发差几毫秒到几秒；AI 在想的时候后台命令可能也在跑")
    else:
        details.append("- AI 时间没算出来：没找到本次的会话记录，或记录里认不出模型请求")
    details += notes

    reserved = {"agent", "wt", "start", "end", "wall_secs", "test_secs"} | set(kv)
    marker = [f"agent={agent}", f"wt={wt}",
              f"start={start_dt.isoformat(timespec='seconds')}",
              f"end={end_dt.isoformat(timespec='seconds')}",
              f"wall_secs={wall}"]
    if kv_line.strip():
        marker.append(kv_line.strip())
    if extra is not None and not isinstance(extra, str):
        marker.append(f"test_secs={extra[0]}")
        for k, v in extra_kv:
            if RE_KEY.match(k) and safe_value(v) and k not in reserved:
                reserved.add(k)
                marker.append(f"{k}={v}")

    return "\n".join(["---", head, "<details><summary>细节</summary>", ""] + details
                     + ["", "</details>", f"<!-- agent-metrics {' '.join(marker)} -->"])


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", required=True)
    ap.add_argument("--driver", required=True)
    ap.add_argument("--config", default="")
    ap.add_argument("--start", required=True)
    ap.add_argument("--wt", required=True)
    a = ap.parse_args(argv)
    try:
        start_epoch = time.mktime(time.strptime(a.start, "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        print(f"comment-footer: 开始时刻格式不对：{a.start}", file=sys.stderr)
        return 2
    start_epoch = int(start_epoch)
    human = run_driver(a.driver, start_epoch, False)
    kv_line = run_driver(a.driver, start_epoch, True)

    extra = None
    cmd = extra_cmd_from_config(a.config)
    if cmd:
        out, why = run_extra(cmd, {
            "CAVIL_FOOTER_START": a.start, "CAVIL_FOOTER_START_EPOCH": str(start_epoch),
            "CAVIL_FOOTER_WORK_NUM": a.wt, "CAVIL_FOOTER_WORKTREE": os.getcwd(),
            "CAVIL_FOOTER_AGENT": a.agent})
        if out is None:
            extra = why
        else:
            extra = parse_extra(out)
            if extra is None:
                extra = "的输出第一行不是「test_secs=秒数」"

    print(render(a.start, start_epoch, time.time(), a.agent, a.wt, human, kv_line, extra))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
