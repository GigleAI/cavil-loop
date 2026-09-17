# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

1. **面向人类的评论文本不得直接暴露内部状态码。** 用量 footer 曾直接显示英文状态词 `full`，改为中文人话说明，机器状态只留在隐藏 HTML 注释里。给非工程背景人员看的字段，发布前需自查是否裸露内部术语。
   证据：[PR #23](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754)、[修复](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)。

2. **金额展示须标注"参考估算"而非"实际账单"。** Codex 价格按官方公开标价换算，未与真实扣费核验，每处展示金额都需带此限定语。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[PR #23](https://github.com/GigleAI/cavil-loop/pull/23)。

3. **内置默认价格表须带来源日期与过期信号，并保留覆盖/关闭开关。** 未配置时用静态快照价目并标注核对日期；显式配置可整表替换，`{}` 可关闭估算。过期提示目前仅在展示层，无自动定期复核（推断）。
   证据：[PR #23](https://github.com/GigleAI/cavil-loop/pull/23)。

4. **Open Questions 复选框可被作者直接编辑"拍板"，须核对 `updated_at` 与正文而非只看最新评论时间；仅靠打标签或 issue 被关闭、无显式文字/勾选确认时不能推定已确认，需明确写为未验证。** issue #22 方案评论被编辑改选项即为一例；issue #28、issue #29 均只有 1 条方案评论、无显式文字确认便进入开发或随 PR 一并被关闭，是否经确认属未验证事实，需在报告中明确标注为推断。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[issue #28](https://github.com/GigleAI/cavil-loop/issues/28#issuecomment-5709122169)、[issue #29](https://github.com/GigleAI/cavil-loop/issues/29#issuecomment-5709391399)。

5. **独立复审能在合并前拦住真实问题并提供比"读代码"更硬的验证手段，但也有其局限。** 有效手段包括：用改动前的历史测试直接跑在新实现上做回归反向验证（--kv 字段是否变化）、端到端调用真实解析函数而非只比对正则、变异测试配合真实数据可达性核查来判断覆盖缺口是否阻塞。局限：复审执行体可能只是同一自动化账号下的另一次会话而非独立身份，其自身用量目前无法单独核算；"本机手动验证/测试脚本通过"不等于"真实 daemon 生产派工已跑通"，PR 合并动作本身也不代表生产环境已实际运行过该改动，两者需在报告中分别声明，不可混用"已验证"一词。
   证据：[PR #23 复审](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5690315790)、[PR #30 复审第 1 轮](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[PR #30 修复说明](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709323575)、[PR #31 复审](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710415519)。

6. **修改 CI/复审工具自身运行时依赖的基础设施脚本（如软链接指向 main 的技能脚本）时，验证结果天然存在版本滞后的自指边界，需主动声明，不能等被质疑才解释。** 本项目技能目录软链接指向 main checkout，PR 改动该脚本时，PR 自己和复审产生的 footer 会先看到旧版行为——这不是 bug，而是"改的就是复审自己依赖的脚本"这一类问题。PR #27 首次遇到，PR #31 再次遇到并复用同一应对方式：主动声明 + 同一时间窗口新旧版本负对照（其余变量不变，只切换脚本版本，证明差异只来自目标改动）。已出现两次，应视为本项目的固定风险点。
   证据：[PR #27](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707594020)、[PR #27 追问](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707826052)、[PR #31 首条报告](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)。

7. **一次性/单次覆盖参数不要与持久配置复用同一环境变量名（尤其接收方子进程会自行 source 同名配置文件时）；跨进程/跨配置边界的行为需要跨该边界的回归测试，并用"退回旧实现应失败"的负对照证明新测试确实能分辨新旧实现。** PR #30 首版把 review 单次模型覆盖放进 `WORKER_MODEL` 环境变量传给 dispatch 子进程，子进程 source 配置后同名赋值将其覆盖，导致普通模型串到 review、空值还会抹掉显式 review 覆盖；同批新增测试只在当前 shell 做字符串匹配、未跨真实子进程边界，此 bug 存在时仍全部通过。修复改用独立变量名+显式覆盖标记；复审用负对照（临时回退实现）验证新测试确实从全绿掉到有失败，证明测试确能分辨新旧实现。
   证据：[复审第 1 轮](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[修复说明](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709323575)、[复审第 2 轮负对照](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709363152)。

8. **GitHub Project v2 看板的字段写权限，与仓库 issue/PR 标签写权限、OAuth `project` scope 是三件互相独立的事。** 即使 PAT 已勾 `project` scope，账号对某个具体看板仍可能是只读协作者（`viewerCanUpdate:false`），导致 `UpdateProjectV2ItemFieldValue` 被拒；诊断时应分层核实"scope 是否具备"与"该账号对该资源的角色权限是否具备"，不要混为一谈。遇到此类失败应如实上报、给出可选项交由人类拍板，不擅自提权或静默跳过；GitHub 对 ProjectV2 迭代字段变更不产生 timeline 事件，事后可能无法证实"是人工手动设置还是看板自动化补齐"，该类问题的最终归因可能长期缺乏可查证据，报告中应明确写为未定论而非强行归因。
   证据：[PR #31 首条报告](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)、[PR #31 复审第 4 节](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710415519)。
