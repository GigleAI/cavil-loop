# 等前置规则（本项目开启了等前置标签 `@@LABEL_PENDING_BLOCKED@@`）

> 这一段只改一件事：工作卡在**别的 issue / PR 还没完成**上时（本仓库的、别的仓库的都行），不翻 `${LABEL_PENDING_HUMAN}` 交人，而是登记前置、挂 `@@LABEL_PENDING_BLOCKED@@` 等它完成；daemon 会定期检查，前置全部完成后自动把本条翻回派工标签，派你回来接着干。其余一律以上文为准。

## 什么时候用

- 只用于「等别的条目合并 / 完成」：例如要用的接口在另一个还没合并的 PR 里、必须等另一个 issue 先做完
- 要人回答问题、拍板、动手（权限、凭据、产品取舍），测试红灯要人裁决，发现可疑内容——这些仍照上文翻 `${LABEL_PENDING_HUMAN}`，不要挂等前置标签

## 怎么挂

1. **登记前置**：发一条交人评论（照上文交人评论的写法：标题说清在等谁、为什么、前置完成后 agent 接着做什么），评论里另起一行写下这个隐藏标记，列出全部前置编号，`resume=` 后面写本次派你来的标签（前置完成后 daemon 用它把本条翻回来）：
   ```
   <!-- agent-blocked-by: #12 #34 resume=${LABEL_PENDING_AGENT} -->
   ```
   别的仓库的前置写成 `OWNER/REPO#编号`（不带仓库名的 `#编号` 一律指本仓库），可以和本仓库的混写：
   ```
   <!-- agent-blocked-by: #12 GigleAI/cavil-loop#238 resume=${LABEL_PENDING_AGENT} -->
   ```
   前置变了就再发一条新标记（daemon 只认这一轮等待里最新的一条，所以每次都写全）。前置是 issue 时也可以同时在本条侧栏 Relationships 设「Blocked by」——daemon 两处都认，别的仓库的 issue 也行；**PR 不能设成「Blocked by」**（GitHub 只接受 issue），等 PR 只能靠标记
2. **翻标签**（编号是本条 issue / PR）：`flip_label <编号> --add @@LABEL_PENDING_BLOCKED@@ --remove ${LABEL_AGENT_DOING}`
3. 停 idle

daemon 的处理：前置全部完成（issue 以「已完成」关闭、PR 已合并）→ 留一条带 `<!-- agent-blocked-resolved ... v=resume -->` 的评论并翻回 `resume=` 的标签；有前置以失败收场（issue 关成不做 / 重复、PR 没合并就关）、别的仓库的前置读不到（不存在或轮询令牌无权读那个仓库）、或找不到前置 → 翻 `${LABEL_PENDING_HUMAN}` 交人。临时读不到 GitHub（网络、限流）时它什么都不做，下一轮再看。

## 被叫回来时

最新一条是 daemon 那条「前置已完成，自动继续」评论：说明你等的前置都已完成。先 `git fetch` 并把主干合进来（前置的改动多半要用），接着上次停下的地方干，照上文正常交付。

「已合并」不等于「本机已生效」：等的如果是本机装着的工具（例如 loop 自己）的改动，先核对本机部署的版本是否已包含那次合并（托管安装合并后一般 10 分钟内生效）。还没包含就隔几分钟再核对；约 15 分钟后仍未生效，照上文翻 `${LABEL_PENDING_HUMAN}` 交人，写明在等哪个提交、本机现在是哪个版本——不要再挂等前置标签（前置已经合并，daemon 会立刻又把本条翻回来）。

@@BLOCKED_SPLIT_RULE@@
