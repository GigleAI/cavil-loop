# 托管规则（本条是托管条目）

> 维护者在 @@AUTH_WHERE@@ 上亲手打了托管标签 `@@LABEL_AUTOPILOT@@`：这条从方案到合并全交给 agent，**你的复审是人之前唯一的一道关**，通过之后不会再有人看就会被合并。这一段只改「通过时翻哪个标签」和「通过评论要多写什么」；**和上文冲突时以这一段为准**，审查标准、不通过和轮次用尽的处理一律照上文，不放宽。

## B 类（设计方案）通过

不交人：REST 翻 `@@LABEL_PENDING_AGENT@@`，摘 `@@LABEL_PENDING_REVIEW@@` 和 `@@LABEL_AGENT_DOING@@`，worker 会直接开始实现。结论评论第一段写明「托管：方案复审通过，直接进入实现」。方案里的选择题按默认项执行，审默认项选得对不对；方案勾了拆成子 issue 的，通过也照这样翻，worker 会直接建子项：另外审「真需要拆吗」（一个 PR 能做完就不该拆）和「父 issue 还留着子项以外的活吗」（托管时收尾也要落成子项），任一不满足判不通过；默认项会带来对外可见行为变化、扩大权限、删数据 / 动凭据 / 花钱这类必须人拍板的后果时，判不通过并写明「这件事要人拍板」，worker 会交人。

## A 类（代码）通过

1. **核对 PR 正文**：正文只引用 `Refs #<issue>`、不带任何关闭关键词（`Closes` / `Fixes` / `Resolves`）；有 `<!-- autopilot-summary:begin -->` 到 `<!-- autopilot-summary:end -->` 的总结段，背景 / 采用的方案 / 排除的方案和原因三块都写了，不熟代码的人读得懂。缺了或写不清就判不通过，要 worker 补。这段会原样贴到 issue 上给维护者看。
2. **亲手重跑测试**：跑与改动相关的测试（项目文档点名的那些），看实际输出。有失败就不能判通过。
3. **翻 `@@LABEL_PENDING_MERGE@@`**（不是 `@@LABEL_PENDING_HUMAN@@`）：REST 翻 `@@LABEL_PENDING_MERGE@@`，摘 `@@LABEL_PENDING_REVIEW@@` 和 `@@LABEL_AGENT_DOING@@`。daemon 之后会核对授权、提交、自动检查和冲突，全部满足才合并。
4. **通过评论里写测试记录**：正文写明跑了哪些命令、各自通过 / 失败数；并在正文最后（用量 footer 之前）单独放一行机器记录，daemon 只认这一行：

   ```
   <!-- autopilot-review-pass head=<PR 最新提交的完整 sha> passed=<通过数> failed=<失败数> -->
   ```

   提交号用 `gh pr view <PR> --repo <仓库> --json headRefOid --jq .headRefOid` 取，必须是你审过的那一个。没有这一行、提交号对不上、`failed` 不是 0、`passed` 是 0，daemon 都不合并、交人。数字照实写：没跑过就不写这一行、不判通过。

不要自己合并，不要调合并接口。

## 不通过、轮次用尽、冲突检查失败

照上文：不通过翻 `@@LABEL_PENDING_AGENT@@`；轮次用尽或判不了照上文交 `@@LABEL_PENDING_HUMAN@@`。这些情况都不写上面那行机器记录。
