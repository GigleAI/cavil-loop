#!/usr/bin/env python3
"""codex 目录信任记录的读与写（~/.codex/config.toml 的 [projects."<路径>"]）。GitHub#108。

由 scripts/drivers/codex.sh 调用，不单独使用：

    codex_trust.py verify <cfg> <key>...       全部已是 trusted → 退出 0，否则 1
    codex_trust.py render <cfg> <out> <key>... 把新内容写进 out：
                                               0 = 写好了；10 = 不用写；其他 = 拒绝，cfg 不动

只做「在文件末尾追加一段 [projects."<key>"] trust_level = "trusted"」，不重新序列化整份文件——
用户的注释、排版、别的表一个字节都不动。追加之后再整体解析一遍，读出来对不上就拒绝。

不改用户的决定：某个 key 已经有记录但不是 trusted（例如手动设成 untrusted），原样保留，
只在 stderr 说一句。文件读不懂（不是合法 TOML、projects 不是表……）一律拒绝。

并发由调用方（_common.sh 的 trust_config_locked_update）负责：本脚本只是纯函数。
"""
import json
import os
import sys

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - 老 Python 才走这里
    try:
        import tomli as tomllib  # type: ignore
    except ModuleNotFoundError:
        tomllib = None


def warn(msg):
    print(f"[codex driver] WARN: {msg}", file=sys.stderr)


def load(cfg):
    """返回 (原文, 解析结果)。文件不存在 → ("", {})；读不懂 → 抛 ValueError。"""
    if not os.path.exists(cfg):
        return "", {}
    with open(cfg, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8")
    data = tomllib.loads(text)
    projects = data.get("projects", {})
    if not isinstance(projects, dict):
        raise ValueError("projects 不是表")
    return text, data


def level(data, key):
    entry = data.get("projects", {}).get(key)
    if entry is None:
        return None
    if not isinstance(entry, dict):
        return "?"
    return entry.get("trust_level")


def main(argv):
    if tomllib is None:
        warn("这个 python3 没有 tomllib（要 3.11+）也没装 tomli，读不了 codex 配置，不写")
        return 2
    if len(argv) < 2:
        return 2
    mode, cfg = argv[0], argv[1]
    try:
        text, data = load(cfg)
    except (ValueError, UnicodeDecodeError, tomllib.TOMLDecodeError) as e:
        warn(f"{cfg} 读不懂（{e}），不动它；codex 首次进新目录可能卡 trust 弹窗")
        return 1 if mode == "verify" else 3

    if mode == "verify":
        keys = argv[2:]
        return 0 if all(level(data, k) == "trusted" for k in keys) else 1

    if mode != "render" or len(argv) < 3:
        return 2
    out, keys = argv[2], argv[3:]
    missing = []
    for k in keys:
        lv = level(data, k)
        if lv == "trusted":
            continue
        if lv is not None:
            warn(f'{cfg} 里 {k} 已经记成 trust_level={lv!r}，那是人定的，不改')
            continue
        if k not in missing:
            missing.append(k)
    if not missing:
        return 10

    new = text
    if new and not new.endswith("\n"):
        new += "\n"
    for k in missing:
        # JSON 的字符串转义是 TOML 基本字符串的子集（\" \\ \n \uXXXX …）
        new += ("\n" if new else "") + f"[projects.{json.dumps(k, ensure_ascii=False)}]\ntrust_level = \"trusted\"\n"
    try:
        check = tomllib.loads(new)
    except tomllib.TOMLDecodeError as e:
        warn(f"在 {cfg} 末尾追加信任记录后整份文件不再合法（{e}），不写")
        return 3
    if any(level(check, k) != "trusted" for k in missing):
        warn(f"在 {cfg} 末尾追加后读回对不上，不写")
        return 3
    with open(out, "w", encoding="utf-8") as f:
        f.write(new)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
