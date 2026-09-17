## footer 格式（以本节为准）

本项目的 footer 跟 tutor（`GigleAI/GigleTutor-Web`）用同一个格式。上面 base 那段
「`${COMMENT_FOOTER}` 为 `on` 时…」只说了要放哪些信息、没定形状，于是每条评论各写各的
（#25 实测：完工把日期又重复了一遍、token 数字没缩写、括号里的说明自己编了一句）。

`${COMMENT_FOOTER}` 是 `off` 就整段省掉。是 `on` 就按这个形状：

~~~
---
⏱️ 开始 <YYYY-MM-DD HH:MM:SS> · 完工 <HH:MM:SS> · 耗时 <Xm Ys>
token <${AGENT_TOKEN_USAGE_SCRIPT} 不带 --kv 的原样输出>
<!-- agent-metrics agent=… wt=… start=… end=… wall_secs=… <--kv 的原样输出> -->
~~~

渲染出来长这样（形状示例，数字取自 tutor 的一条真实 footer）：

~~~
---
⏱️ 开始 2026-09-16 18:32:05 · 完工 18:36:18 · 耗时 4m 13s
token 65.3k input, 10k output, 543.8k cache read, 0 cache write（该模型未配单价，金额未计）（模型：claude-opus-5）
~~~

三条硬规矩：

1. **完工只写时分秒**，不重复日期。只有「开始」带完整日期——跨天的任务靠它追溯。
2. **token 那一行整行原样用脚本输出**：不要自己换算数字，也不要自己编括号里那句说明。
   脚本已经把数字缩写成 `8.2k` / `1.8m`，也已经按 `cost_state` 把话说成人话了——
   有价 → ` ($4.05)`；部分有价 → ` ($x，部分用量未计价，金额偏低)`；
   没价 → `（该模型未配单价，金额未计）`；内置价目超 90 天它还会自己补一句请复核。
   **行末的模型说明同样由脚本自己补**：`（模型：a、b）`；归属不全时
   `（模型：a；另有模型无法确认）`；一条证据都没有时 `（模型未知）`。
   别再手工往这行加模型名——脚本已经写过一遍，手工再加就是重一份。
   自己重写这句，等于把一个会随价目表变的判断**固定成写评论当天的措辞**。
3. `<!-- agent-metrics ... -->` 必须是**整条评论的最后一个非空行**，周报采集器只认这一行。
   正文里要举 footer 的例子就别用真形状，否则会被当成一次真实记账。

实现（Bash 跨调用不共享 function：每次发评论前 inline 跑一遍，并且用 `--body-file`，
**不**用 `--body "..."` 行内 quote）：

~~~bash
NOW_HMS=$(date '+%H:%M:%S')
START_EPOCH=$(date -d "${TASK_START_TS}" +%s 2>/dev/null || echo 0)
DUR=$(( $(date +%s) - START_EPOCH ))

# 人读行和机器行取同一份数字。脚本必须先收到 epoch，--kv 是第二个参数
TOKEN=$(bash "${AGENT_TOKEN_USAGE_SCRIPT}" "$START_EPOCH" 2>/dev/null); [ -z "$TOKEN" ] && TOKEN="未知"
KV=$(bash "${AGENT_TOKEN_USAGE_SCRIPT}" "$START_EPOCH" --kv 2>/dev/null)

BODY=/tmp/comment-body.md          # 换成你写好正文的那个文件
{
    cat "$BODY"
    printf '\n\n---\n⏱️ 开始 %s · 完工 %s · 耗时 %dm %ds\ntoken %s\n' \
        "${TASK_START_TS}" "$NOW_HMS" "$((DUR / 60))" "$((DUR % 60))" "$TOKEN"
    printf '<!-- agent-metrics agent=%s wt=%s start=%s end=%s wall_secs=%s %s -->\n' \
        "${WORKER_AGENT}" "${WORK_NUM}" \
        "$(date -d "${TASK_START_TS}" --iso-8601=seconds)" "$(date --iso-8601=seconds)" \
        "$DUR" "$KV"
} > "${BODY}.meta"

gh issue comment ${ISSUE} --repo ${REPO} --body-file "${BODY}.meta"
rm -f "${BODY}.meta"
~~~
