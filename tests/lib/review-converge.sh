#!/usr/bin/env bash
# 「和改动前的拼装逐字节一致」那类对拍用的过滤器（GitHub#621）。
#
# GitHub#621 起，复审 prompt 每次都多一段「复审收敛规则」，项目主干上的 REVIEW.md 有 / 读不到时复审和 worker
# prompt 还多一段「本项目的审查标准」。这两段都是 compose_prompt_template 以 `\n\n---\n\n` 分隔追加的整段，
# 不归那些对拍管（它们守的是各自功能关着时不往 prompt 里加东西）。比之前先把这两段整段拿掉，其余逐字节保留：
#   strip_review_converge < 新拼的 prompt > 拿掉这两段之后
# 只认段首的两个标题，别的段一个字节都不动；tests/review-converge.test.sh 断言两段的标题就是这两个。
strip_review_converge() {
    python3 -c '
import sys
s = sys.stdin.buffer.read().decode("utf-8", "surrogateescape")
sep = "\n\n---\n\n"
heads = ("# 复审收敛规则：首轮一次报全，之后只复核修复", "# 本项目的审查标准（仓库根目录 REVIEW.md）")
parts = s.split(sep)
keep = [parts[0]] + [p for p in parts[1:] if not p.startswith(heads)]
sys.stdout.buffer.write(sep.join(keep).encode("utf-8", "surrogateescape"))
'
}
