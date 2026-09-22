# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

1. **面向人类的评论文本不得直接暴露内部状态码。** 用量 footer 曾直接显示英文状态词 `full`，改为中文人话说明，机器状态只留在隐藏 HTML 注释里。给非工程背景人员看的字段，发布前需自查是否裸露内部术语。
   证据：[PR #23](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754)、[修复](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)。

2. **金额/成本类展示需标注为"参考估算"而非"实际账单"，用于估算的价格表要标明来源日期与过期信号，并保留可整表覆盖/可关闭的开关。** Codex 价格按官方公开标价换算，未与真实扣费核验；未配置时用静态快照价目并标注核对日期，显式配置可整表替换，`{}` 可关闭估算；过期提示目前仅在展示层，无自动定期复核（推断）。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[PR #23](https://github.com/GigleAI/cavil-loop/pull/23)。

3. **Open Questions 的人工拍板可以是编辑原评论勾选 checkbox，也可以是直接在新评论里用文字答复（如"可以按默认方案实现"），两种都算有效确认，但复盘/审计时都要落到具体评论 URL 和正文内容核对，不能只凭"最新评论是自己发的"、"issue 已关闭/打了完成标签"或"标签被从待人工直接翻到待复审"来推定已确认。** 无法核实确认方式时，须在报告中明确写"未确认/推断"。
   证据：[issue #22 编辑勾选](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[issue #28](https://github.com/GigleAI/cavil-loop/issues/28#issuecomment-5709122169)、[issue #29](https://github.com/GigleAI/cavil-loop/issues/29#issuecomment-5709391399)、[PR #37 文字确认](https://github.com/GigleAI/cavil-loop/pull/37#issuecomment-5771186863)、[PR #37 标签跳转自述（未独立核实）](https://github.com/GigleAI/cavil-loop/pull/37)。

4. **独立复审能在合并前拦住真实问题，但要用对应阶段的标准：纯方案（无代码）阶段应审"方案是否值得人看"，不得以"没有实现/没有测试"打回——项目 review 模板本身写明这条规则；出现复审对设计阶段套用代码验收标准的情况，应在复盘中记录为流程执行偏差，而非视为正常。** 同时，沙盘/单元测试全绿、复审自陈"实测通过"，都不等于"真实生产 daemon 已跑通"，PR 合并动作本身也不代表生产环境已实际执行该改动——三者要分别声明，不能互相替代。
   证据：[PR #23 复审](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5690315790)、[PR #30 复审](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[PR #31 复审](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710415519)、[issue #34 复审第1轮误用代码标准](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769671286)、[PR #37 正文披露未跑生产](https://github.com/GigleAI/cavil-loop/pull/37)。

5. **修改 CI/复审工具自身运行时依赖的基础设施脚本（如软链接指向 main 的技能脚本）时，验证结果天然存在版本滞后的自指边界，需主动声明，不能等被质疑才解释。** 本项目技能目录软链接指向 main checkout，PR 改动该脚本时，PR 自己和复审产生的结果会先看到旧版行为——这不是 bug，而是"改的就是复审自己依赖的脚本"这一类问题。已连续在 3 个 PR 中出现（#27、#31、#37），应视为本项目的固定风险点。
   证据：[PR #27](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707594020)、[PR #31](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)、[PR #37 正文第4节](https://github.com/GigleAI/cavil-loop/pull/37)。

6. **一次性/单次覆盖参数不要与持久配置复用同一环境变量名（尤其接收方子进程会自行 source 同名配置文件时）；跨进程/跨配置边界的行为需要跨该边界的回归测试，并用"退回旧实现应失败"的负对照证明新测试确实能分辨新旧实现。** PR #30 首版把 review 单次模型覆盖放进 `WORKER_MODEL` 环境变量传给 dispatch 子进程，子进程 source 配置后同名赋值将其覆盖，导致普通模型串到 review；同批新增测试未跨真实子进程边界，此 bug 存在时仍全部通过。修复改用独立变量名+显式覆盖标记；复审用负对照验证新测试确实从全绿掉到有失败。
   证据：[复审第1轮](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[修复说明](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709323575)、[复审第2轮负对照](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709363152)。

7. **GitHub Project v2 看板的字段写权限，与仓库 issue/PR 标签写权限、OAuth `project` scope 是三件互相独立的事。** 即使 PAT 已勾 `project` scope，账号对某个具体看板仍可能是只读协作者，导致字段写入被拒；诊断时应分层核实"scope 是否具备"与"该账号对该资源的角色权限是否具备"。遇到此类失败应如实上报、给出可选项交由人类拍板，不擅自提权或静默跳过；GitHub 对 ProjectV2 迭代字段变更不产生 timeline 事件，事后可能无法证实归因，报告中应明确写为未定论。
   证据：[PR #31 首条报告](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)、[PR #31 复审第4节](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710415519)。

8. **根因排查阶段应在沙盘里对"看似显然"的机制性假设做实测，而不是仅凭读代码猜测；修复某个失败点后，还要检查其紧邻的下一步操作是否会在该失败消除后暴露新的次生风险。** 本项目曾实测发现：(a) 脚本顶部 `exec 2>/dev/null` 是永久重定向，导致子进程 stderr 实际被丢弃而非"只是没被捕获"，此前能在日志看到报错纯属该行代码恰好写了 `2>&1` 的巧合；(b) 分支被其他 worktree 占用时，`git fetch` 会拒绝，但下一行 `git worktree add --force` 反而会成功、制造双 worktree 共用一分支的冲突——只修好 fetch 不足够。新增匹配类逻辑（如按分支名/标签名判断归属）要专门测试"全等匹配 vs 子串误判"陷阱（如 `issue-3` 误配 `issue-34`），本项目已反复踩过这类坑，应作为固定检查项。
   证据：[issue #34 方案评论第1节实测](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769590395)、[PR #37 正文第1、2节](https://github.com/GigleAI/cavil-loop/pull/37)。
