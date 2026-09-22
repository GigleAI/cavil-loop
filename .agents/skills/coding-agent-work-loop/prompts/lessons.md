# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

1. **面向人类的评论文本不得直接暴露内部状态码。** 用量 footer 曾直接显示英文状态词 `full`，改为中文人话说明，机器状态只留在隐藏 HTML 注释里。给非工程背景人员看的字段，发布前需自查是否裸露内部术语。
   证据：[PR #23](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754)、[修复](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)。

2. **金额/成本类展示需标注为"参考估算"而非"实际账单"，用于估算的价格表要标明来源日期与过期信号，并保留可整表覆盖/可关闭的开关。** Codex 价格按官方公开标价换算，未与真实扣费核验；未配置时用静态快照价目并标注核对日期，显式配置可整表替换，`{}` 可关闭估算；过期提示目前仅在展示层，无自动定期复核（推断）。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[PR #23](https://github.com/GigleAI/cavil-loop/pull/23)。

3. **Open Questions 的人工拍板可以是编辑原评论勾选 checkbox，也可以是直接在新评论里用文字答复，两种都算有效确认；但也可能自始至终没有勾选、也没有文字回复，仅凭"label 被重新打回 pending/agent"这一个信号按约定默认项执行——三种情况在复盘/审计时都要落到具体评论 URL、`created_at`/`updated_at` 和正文核对，不能只凭"最新评论是自己发的"、"issue 已关闭/打了完成标签"来推定已确认。** 无法核实确认方式时，须在报告中明确写"未见书面确认，按默认项执行"。
   证据：[issue #22 编辑勾选](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[issue #28](https://github.com/GigleAI/cavil-loop/issues/28#issuecomment-5709122169)、[issue #29](https://github.com/GigleAI/cavil-loop/issues/29#issuecomment-5709391399)、[PR #37 文字确认](https://github.com/GigleAI/cavil-loop/pull/37#issuecomment-5771186863)、[PR #38：Q1 全程未勾选，仅凭 relabel 推断按默认 B 执行](https://github.com/GigleAI/cavil-loop/pull/38)。

4. **独立复审能在合并前拦住真实问题，但要用对应阶段的标准：纯方案（无代码）阶段应审"方案是否值得人看"，不得以"没有实现/没有测试"打回。** 同时，沙盘/单元测试全绿、复审自陈"实测通过"、PR 合并动作，三者都不等于"生产环境已实际执行该改动/真实多账号已分别工作"——三者要分别声明，不能互相替代；PR 正文用"跑过/没跑过"两栏如实披露是值得保留的做法。
   证据：[PR #23 复审](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5690315790)、[PR #30 复审](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[issue #34 复审第1轮误用代码标准](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769671286)、[PR #37 正文第4节](https://github.com/GigleAI/cavil-loop/pull/37)、[PR #38 正文第5节：双账号/生产派工均未跑](https://github.com/GigleAI/cavil-loop/pull/38)。

5. **修改 CI/复审工具自身运行时依赖的基础设施脚本（如软链接指向 main 的技能脚本）时，验证结果天然存在版本滞后的自指边界，需主动声明，不能等被质疑才解释。** 本项目技能目录软链接指向 main checkout，已连续在 4 个 PR 中出现"改的就是复审自己要用的脚本，合并前复审看到的仍是旧版行为"这一情形，应视为固定风险点。
   证据：[PR #27](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707594020)、[PR #31](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)、[PR #37 正文第4节](https://github.com/GigleAI/cavil-loop/pull/37)、[PR #38 正文第5节第4条](https://github.com/GigleAI/cavil-loop/pull/38)。

6. **涉及密钥的环境变量/配置文件有三类容易被忽视的失效模式：** ①一次性覆盖参数复用持久配置同名变量，会被接收方 source 同名配置覆盖；②配置文件"裸赋值"（不加 `export`）能否被 `gh`/`git` 等子进程看到，取决于该变量此前是否已在环境中被 export 过——已配置过的开发机会掩盖此问题，须用全新变量名 + `env -u` 清空环境后重测才能暴露；③安装脚本常未强制收紧密钥配置文件权限（umask 下可能落地为同机任何用户可读），需显式 `chmod 600`，且对已存在的老安装文件也要补做（不覆盖内容）。跨进程边界的改动需要跨边界回归测试 + 负对照（退回旧实现应变红）。
   证据：[PR #30 复审第1轮](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[PR #30 修复](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709323575)、[issue #36 裸赋值坑实测](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771691189)、[PR #38 chmod 600 实现](https://github.com/GigleAI/cavil-loop/pull/38)。

7. **GitHub Project v2 看板的字段写权限，与仓库 issue/PR 标签写权限、OAuth `project` scope 是三件互相独立的事。** 即使 PAT 已勾 `project` scope，账号对某个具体看板仍可能是只读协作者；遇到此类失败应如实上报、给出可选项交由人类拍板，不擅自提权或静默跳过；ProjectV2 迭代字段变更不产生 timeline 事件，事后可能无法证实归因，报告中应明确写为未定论。
   证据：[PR #31 首条报告](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)、[PR #31 复审第4节](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710415519)。

8. **根因排查与方案设计阶段都应对"看似显然"的假设做实测或独立核实，不能只信读代码/既有文字描述。** 已验证：(a) `exec 2>/dev/null` 永久重定向使子进程 stderr 被丢弃；(b) 分支被占用时 `git fetch` 拒绝但下一行 `git worktree add --force` 仍会成功造成双 worktree 冲突，只修一处不够；(c) issue 正文自带的"现状盘点"即使出自此前 agent 轮次也可能有遗漏——设计阶段重新读代码，发现 daemon 除翻 label 外还有 `git push`（复盘）和告警 issue 开关两处写，遗漏会导致按错误前提选错架构（原倾向方案因此改判）。新增匹配逻辑要测"全等匹配 vs 子串误判"。
   证据：[issue #34 方案评论](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769590395)、[PR #37 正文第1、2节](https://github.com/GigleAI/cavil-loop/pull/37)、[issue #36 补充盘点](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771504273)。
