#!/usr/bin/env python3
"""造一批「解得稳、但与外部参照冲突」的 CLI 记账样本，让真实求解器判出 disputed。

做法同 price-identifiability 第 2 组那个核心反例：账单按真实单价出，但**观测里的
output 记成真值的一半** —— 解出来的 output 单价就偏 100%，两条稳定性闸门全过，
只有外部参照能抓住它。用它来给 disputed 那一态造一条端到端样本（#934 第 9 轮）。

用法：mk-disputed-samples.py <目标目录>
"""
import json, os, random, sys

base = sys.argv[1]
rnd = random.Random(20260914)      # 固定种子：各列独立、满秩
for k in range(30):
    i = rnd.uniform(20, 100) * 1000
    o = rnd.uniform(4, 20) * 1000
    cr = rnd.uniform(200, 1000) * 1000
    cw = rnd.uniform(10, 50) * 1000
    cost = (i * 5 + o * 25 + cr * 0.5 + cw * 10) / 1e6     # 真实单价算出的账
    obs_o = o * 0.5                                         # 观测把 output 记少一半
    d = os.path.join(base, f"s{k}")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"s{k}.jsonl"), "w", encoding="utf-8") as f:
        f.write(json.dumps({"type": "assistant", "timestamp": "2026-09-01T00:00:00.000Z",
                            "requestId": f"r{k}",
                            "message": {"model": "claude-opus-5", "usage": {
                                "input_tokens": 1, "output_tokens": 1,
                                "cache_creation": {"ephemeral_5m_input_tokens": 0,
                                                   "ephemeral_1h_input_tokens": int(cw)}}}}) + "\n")
        f.write(json.dumps({"type": "cost-state", "startTime": 0, "totalCostUSD": cost,
                            "modelUsage": {"claude-opus-5": {
                                "inputTokens": int(i), "outputTokens": int(obs_o),
                                "cacheReadInputTokens": int(cr),
                                "cacheCreationInputTokens": int(cw)}}}) + "\n")
