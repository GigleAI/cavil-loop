#!/usr/bin/env python3
"""评论用量 footer 的生成器（GitHub#88），由 comment-footer.sh 调用。参数见那个文件头。

形状（数字示意）：

    ---
    <details><summary>⏱️ 耗时：8m 0s（AI 约 2m 30s · 测试 4m 51s · 远端 CI 约 40s · 其他 0s）｜模型：claude-opus-5-5 · 8.6m token · 约 $2.48</summary>

    - 开始 2026-10-27 08:48:16 · 完工 08:56:16
    - <项目命令给的分条文字，原样>
    - 远端 CI 约 40s（等待 1 条，按会话记录识别）：
      - 等 Actions 运行 123：08:50:01 → 08:50:41，40s
    - token 明细：<用量驱动的人读行，原样>

    </details>
    <!-- agent-metrics agent=… wt=… start=… end=… wall_secs=… <驱动 --kv 原样> ci_wait_secs=… ci_waits=… ci_wait_untimed=… test_secs=… <项目字段> -->

规矩：
  · 机器记录是最后一个非空行（周报采集器只认这一行）。
  · 总览就是折叠块的标题（GitHub#90）：收起时只剩这一行，展开箭头在行首。总览按 HTML
    转义后放进 <summary>，某个模型名带了尖括号也弄不坏折叠块。
  · 总览里的各段按 AI、测试、远端 CI、其他的顺序排（GitHub#93 / #293），按**显示出来的整秒**相减：
    「其他」= 总 − AI − 测试 − 远端 CI，最小 0。各段不重叠时
    相加恰好等于总耗时；测试和 AI 有重叠（AI 在想、测试在后台跑）时「其他」记 0，细节里说明。
  · 远端 CI（GitHub#293）：用量驱动 --ci-wait 给一行 JSON（ci_wait.py）。等待时段的并集已扣掉与 AI 重合的
    部分，所以不和 AI 重叠；和测试的重叠扣不掉（测试只给总数），同样按「其他」记 0 处理。总览只在
    合计至少 1 秒、或有等待但一条都没记到结束（「远端 CI 未知」）时出现；细节逐条列出，并写明重叠、
    扣掉的 AI 时间、没记到结束的条数。没有等待时 footer 可见部分与以前一字不差，机器记录写
    ci_wait_secs=0.000 ci_waits=0 ci_wait_untimed=0。统计不出来时三个字段都不写，细节写原因。
  · AI 时间算不出来就写「AI 时间未知」，不写 0、也不算「其他」。AI 时间的估算口径写在
    docs/operations.md，不在每条评论里重复一大段说明。
  · token 明细整行用驱动的人读输出，金额措辞、价目提醒、模型说明都在里面，这里不重写；
    总览只按机器字段给一个短说法。
  · 项目命令（配置项 COMMENT_FOOTER_EXTRA_CMD）：没配、或命令确认这轮没跑（0 秒），总览都不提
    测试（GitHub#93；机器记录照写 test_secs=0，周报仍分得清「没跑」和「没配」）；大于 0 秒写
    「测试 4m 51s」；命令回答 unknown（跑过但说不出耗时）或失败 / 超时 / 首行不对写「测试未知」，
    后者在细节里写原因——统计坏了要让人看得见。不管哪种 footer 都照常出；项目字段与已有字段
    同名的丢掉，不覆盖核心字段。
"""
import argparse
import datetime
import html
import json
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
TEST_UNKNOWN = "unknown"    # 项目命令的回答「跑过测试、耗时说不出」


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


def run_ci_wait(driver, start_epoch):
    """用量驱动的 --ci-wait → None（没有会话文件，什么也不说）| 失败原因 str | 结果 dict。"""
    try:
        r = subprocess.run(["bash", driver, str(start_epoch), "--ci-wait"], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return "统计没跑完"
    out = (r.stdout or "").strip()
    if r.returncode != 0:
        return f"统计脚本出错（退出码 {r.returncode}）"
    if not out:
        return None
    return parse_ci_wait(out.splitlines()[0])


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x >= 0


def parse_ci_wait(line):
    """校验 ci_wait.py 那一行 JSON；形状不对一律当「读不懂」，不当「没等过」。"""
    bad = "统计输出读不懂"
    try:
        d = json.loads(line)
    except ValueError:
        return bad
    if not isinstance(d, dict) or d.get("v") != 1 or not isinstance(d.get("read"), bool):
        return bad
    if not d["read"]:
        why = d.get("why")
        return why if isinstance(why, str) and why else "会话记录读不了"
    waits = d.get("waits")
    if not isinstance(waits, list) or not _num(d.get("untimed")) or not _num(d.get("ai_cut")):
        return bad
    if not (d.get("secs") is None or _num(d["secs"])) or (waits and d.get("secs") is None and d["untimed"] != len(waits)):
        return bad
    for w in waits:
        if (not isinstance(w, dict) or w.get("what") not in ("run", "pr", "") or not isinstance(w.get("id"), str)
                or not _num(w.get("start")) or not (w.get("end") is None or _num(w.get("end")))
                or (w.get("end") is None) != (w.get("secs") is None)
                or not (w.get("secs") is None or _num(w["secs"]))):
            return bad
    if not waits and d.get("secs") is None:
        return bad
    return d


def secs_ms(x):
    """机器字段：毫秒精度原样写（与 ai_secs 同一写法），不舍入到整秒。"""
    ms = int(round(x * 1000))
    return f"{ms // 1000}.{ms % 1000:03d}"


def wait_label(w):
    what, wid = w["what"], w["id"]
    if what == "run":
        return f"等 Actions 运行 {wid}" if wid else "等 Actions 运行（编号没读出来）"
    if what == "pr":
        return f"等 PR #{wid} 的检查" if wid else "等 PR 的检查（编号没读出来）"
    return "等远端 CI"


def ci_wait_parts(ci, wall, start_dt):
    """→ (总览那一段 | None, 计入减法的整秒 | None, 细节行, 机器字段)。"""
    if ci is None:
        return None, None, [], []
    if isinstance(ci, str):
        return None, None, [f"- 远端 CI 等待没统计到：{ci}"], []
    waits, secs, untimed = ci["waits"], ci["secs"], int(ci["untimed"])
    kv = ([f"ci_wait_secs={secs_ms(secs)}"] if secs is not None else []) + [
        f"ci_waits={len(waits)}", f"ci_wait_untimed={untimed}"]
    seg, ci_int, lines = None, None, []

    def at(t):
        dt = datetime.datetime.fromtimestamp(t).astimezone()
        return dt.strftime("%H:%M:%S") if dt.date() == start_dt.date() else dt.strftime("%Y-%m-%d %H:%M:%S")

    if waits:
        if secs is None:
            seg = "远端 CI 未知"
            lines.append(f"- 远端 CI：等待 {len(waits)} 条，都没记到结束，时长未知（按会话记录识别）：")
        else:
            ci_int = min(int(round(secs)), wall)
            seg = f"远端 CI 约 {fmt_dur(ci_int)}" if ci_int > 0 else None
            lines.append(f"- 远端 CI 约 {fmt_dur(ci_int)}（等待 {len(waits)} 条，按会话记录识别）：")
        for w in waits:
            if w["end"] is None:
                lines.append(f"  - {wait_label(w)}：{at(w['start'])} 起，结束未记到")
            else:
                lines.append(f"  - {wait_label(w)}：{at(w['start'])} → {at(w['end'])}，{fmt_dur(round(w['secs']))}")
        if ci.get("overlap"):
            lines.append("  - 几条等待时间上有重叠，合计按并集算、同一段只算一次")
        if int(round(ci["ai_cut"])) > 0:
            lines.append(f"  - 等待期间 AI 也在工作，这 {fmt_dur(round(ci['ai_cut']))} 算进 AI，不重复算进远端 CI")
        if untimed and secs is not None:
            lines.append(f"  - 另有 {untimed} 条没记到结束，合计是下限")
    if _num(ci.get("unparsed")) and ci["unparsed"]:
        lines.append(f"- 另有 {int(ci['unparsed'])} 条命令的写法解析不了，可能含远端 CI 等待，未计入")
    return seg, ci_int, lines, kv


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
    约定：第一个非空行 `test_secs=<秒>`，或 `test_secs=unknown`（项目确认跑过测试、但说不出耗时，
    例如只有后台 / 未完成的运行）；以 `kv ` 开头的行是机器字段；其余非空行原样进细节。
    0 秒的意思是「确认这轮没跑测试」——拿不准有没有跑的项目要回答 unknown，不能回答 0。
    """
    lines = [l.rstrip() for l in out.splitlines()]
    body = [l for l in lines if l.strip()]
    if not body:
        return None
    k, eq, v = body[0].strip().partition("=")
    if k != "test_secs" or not eq or not (v == TEST_UNKNOWN or RE_SECS.match(v)):
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


def render(start_ts, start_epoch, end_epoch, agent, wt, human, kv_line, extra, ci=None):
    """纯函数：所有外部输入都已取好，只管排版。测试直接调它。"""
    kv_pairs = parse_kv(kv_line)
    kv = dict(kv_pairs)
    wall = max(0, int(end_epoch - start_epoch))
    notes = []
    start_dt = datetime.datetime.fromtimestamp(start_epoch).astimezone()
    ci_seg, ci_int, ci_details, ci_kv = ci_wait_parts(ci, wall, start_dt)

    test = None
    test_seg = None     # 总览里测试那一段；没配命令、或命令确认没跑测试时不提
    extra_details, extra_kv = [], []
    if extra is not None:
        if isinstance(extra, str):
            test_seg = "测试未知"
            notes.append(f"- 测试统计没取到：项目命令{extra}")
        else:
            test_text, extra_details, extra_kv = extra
            if test_text == TEST_UNKNOWN:
                test_seg = "测试未知"
            else:
                test_f = float(test_text)
                test = min(int(round(test_f)), wall) if test_f > 0 else None
                test_seg = f"测试 {fmt_dur(test)}" if test is not None else None

    ai = None
    try:
        ai = min(int(round(float(kv["ai_secs"]))), wall)
    except (KeyError, ValueError):
        pass

    # 顺序：AI、测试、远端 CI、其他（GitHub#93 / #293）
    if ai is not None:
        other = wall - (test or 0) - ai - (ci_int or 0)
        segs = [f"AI 约 {fmt_dur(ai)}"]
        if test_seg:
            segs.append(test_seg)
        if ci_seg:
            segs.append(ci_seg)
        segs.append(f"其他 {fmt_dur(max(0, other))}")
        if other < 0 and ci_int:
            notes.append("- 各段时间有重叠（AI 工作或等远端 CI 时测试也在跑），相加超过总耗时，「其他」记为 0")
        elif other < 0:
            notes.append("- 测试和 AI 时间有重叠（AI 工作时测试也在跑），两段相加超过总耗时，「其他」记为 0")
    else:
        segs = ["AI 时间未知"] + ([test_seg] if test_seg else []) + ([ci_seg] if ci_seg else [])

    usage = "token 未知"
    if kv_pairs:
        try:
            total = sum(int(kv.get(k, 0)) for k in ("in", "out", "cache_r", "cache_w"))
            usage = f"{fmt_tok(total)} token · {cost_text(kv)}"
        except ValueError:
            pass
    head = (f"⏱️ 耗时：{fmt_dur(wall)}（{' · '.join(segs)}）"
            f"｜{models_text(kv) if kv_pairs else '模型未知'} · {usage}")

    end_dt = datetime.datetime.fromtimestamp(end_epoch).astimezone()
    details = [f"- 开始 {start_ts} · 完工 {end_dt.strftime('%H:%M:%S')}"]
    details += extra_details
    details += ci_details
    details.append(f"- token 明细：{human}" if human else "- token 明细：未知（没找到本次的会话记录）")
    # AI 时间怎么估写在运维文档里，不每条评论重复（总览的「AI 约」已表明是估算）；算不出来才说明原因
    if ai is None:
        details.append("- AI 时间没算出来：没找到本次的会话记录，或记录里认不出模型请求")
    details += notes

    reserved = {"agent", "wt", "start", "end", "wall_secs", "test_secs",
                "ci_wait_secs", "ci_waits", "ci_wait_untimed"} | set(kv)
    marker = [f"agent={agent}", f"wt={wt}",
              f"start={start_dt.isoformat(timespec='seconds')}",
              f"end={end_dt.isoformat(timespec='seconds')}",
              f"wall_secs={wall}"]
    if kv_line.strip():
        marker.append(kv_line.strip())
    marker += [f for f in ci_kv if f.split("=", 1)[0] not in kv]
    if extra is not None and not isinstance(extra, str):
        if extra[0] != TEST_UNKNOWN:    # 机器记录只写数字；说不出耗时就不写这个字段
            marker.append(f"test_secs={extra[0]}")
        for k, v in extra_kv:
            if RE_KEY.match(k) and safe_value(v) and k not in reserved:
                reserved.add(k)
                marker.append(f"{k}={v}")

    return "\n".join(["---", f"<details><summary>{html.escape(head, quote=False)}</summary>", ""] + details
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
    ci = run_ci_wait(a.driver, start_epoch)

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

    print(render(a.start, start_epoch, time.time(), a.agent, a.wt, human, kv_line, extra, ci))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
