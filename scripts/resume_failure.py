#!/usr/bin/env python3
"""认「这条对话本身续不上」的屏幕（GitHub#738）。

用法：resume_failure.py <agent>  < 屏幕文字
输出：认出时一行「<类别>\t<一句白话原因>」；认不出什么都不输出。退出码 0；用法不对 2。

为什么要有：续接的对话里记着一些本机已经不认的东西（换掉的模型供应商、删掉的对话文件）时，
CLI 一打开就报错退出。重试多少次都一样，只有换一条新对话才能接着干。
daemon 在 worker 退出时存下最后一屏（scripts/agent-exit-screen.sh），自动恢复和派工脚本拿它问这里。

规则只按真实截屏写，样本在 tests/fixtures/resume-failure/（README 写了每张怎么来的）。
没有样本的情况（对话文件损坏等）不写匹配：认不出就照旧重试、用完次数后交人。
只看最后 20 个非空行：报错是程序退出前的最后输出，上文里出现的同样文字（例如对话内容里引用了它）不算。
"""
import re
import sys

TAIL_LINES = 20

# (类别, 规则, 原因)。原因是给人看的固定句子，会写进 GitHub 评论：不能带屏幕上的任何原文。
RULES = {
    "codex": [
        ("provider-gone",
         re.compile(r'"type":"modelProviderNotConfigured"|uses model provider .{1,80}, which is no longer configured'),
         "这条对话记着的模型供应商已不在本机 codex 的配置里，codex 拒绝续接这条对话"),
        ("session-missing",
         re.compile(r"^ERROR: No saved session found with ID \S+"),
         "codex 找不到这条对话的记录"),
    ],
    "claude": [
        ("session-missing",
         re.compile(r"^No conversation found with session ID: \S+"),
         "claude 找不到这条对话的记录"),
    ],
}


def classify(agent, text):
    rules = RULES.get(agent)
    if not rules:
        return None
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    for line in lines[-TAIL_LINES:]:
        for kind, rx, reason in rules:
            if rx.search(line.strip()):
                return kind, reason
    return None


def main(argv):
    if len(argv) != 2 or not argv[1]:
        print("用法：resume_failure.py <agent> < 屏幕文字", file=sys.stderr)
        return 2
    text = sys.stdin.buffer.read().decode("utf-8", "replace")
    hit = classify(argv[1], text)
    if hit:
        print(f"{hit[0]}\t{hit[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
