# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

1. **面向人类的评论文本不得暴露内部状态码，金额/成本类展示需标注为"参考估算"而非"实际账单"。** 用量 footer 曾直接显示英文状态词 `full`，已改为中文人话说明，机器状态只留在隐藏 HTML 注释里；Codex 价格按官方公开标价换算，未与真实扣费核验，需标注核对日期、显式配置可整表覆盖、`{}` 可关闭估算。发布前需自查是否有裸露的内部术语或把估算包装成确定数字。
   证据：[PR #23 问题](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754)、[修复](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)、[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)。

2. **人工拍板可能以编辑原评论勾选 checkbox、直接文字答复、或仅靠 relabel（不留文字）三种方式出现，且同一 PR 内可能反复出现"只 relabel 不留文字"。** 复盘/审计时须落到具体评论 URL、`created_at`/`updated_at` 和正文核对，不能只凭"最新评论是自己发的"或"label 已翻回"推定已确认；无法核实时须在报告中明确写"未见书面确认，按默认项/推断执行"。PR #39、#44 中人工都出现过只移除 `pending/human` 而无文字的情形，agent 均如实标注为推断并请求纠正。PR #50 同样未见人工书面评论。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[issue #28](https://github.com/GigleAI/cavil-loop/issues/28#issuecomment-5709122169)、[PR #37 文字确认](https://github.com/GigleAI/cavil-loop/pull/37#issuecomment-5771186863)、[PR #39 relabel-only](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774321544)、[PR #44 推断标注](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882562160)、[PR #44 书面确认](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882724800)。

3. **独立复审要用对应阶段的标准（方案阶段审"值不值得看"，不得以"没实现/没测试"打回代码阶段的标准）；沙盘/单元测试全绿、复审自陈"实测通过"、PR 合并动作三者互不等价于"生产环境已实际执行该改动"，须分别声明。** PR #39、#44 正文都用"实测过的/没跑过的"分栏披露验证范围，是值得延续的诚实披露格式。PR #50 合并后，真实数据重跑和部署执行仍未验证。
   证据：[PR #23 复审](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5690315790)、[issue #34 复审误用标准](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769671286)、[PR #39 最终通过](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776318505)、[PR #44 通过评论](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882824062)、[PR #50 通过评论](https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049702669)。

4. **自指边界：修改复审/派工工具自身运行时依赖的脚本或模板时，验证结果天然存在版本滞后，需主动声明。** 技能目录软链接指向 main checkout，已在 PR #27 #31 #37 #39 #44 #50 中反复出现"合并前复审和派工仍用旧版"，应视为固定风险点。
   证据：[PR #27](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707594020)、[PR #31](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)、[PR #37 正文](https://github.com/GigleAI/cavil-loop/pull/37)、[PR #39 正文](https://github.com/GigleAI/cavil-loop/pull/39)、[PR #44 正文](https://github.com/GigleAI/cavil-loop/pull/44)、[PR #50 修复评论](https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049668487)。

5. **涉及密钥的环境变量/配置文件有三类易被忽视的失效模式：一次性覆盖参数复用持久配置同名变量会被 source 覆盖；配置文件"裸赋值"能否被子进程看到取决于此前是否已被 export 过（需用全新变量名 + `env -u` 清空环境才能暴露）；安装脚本常未强制收紧密钥文件权限，需显式 `chmod 600` 并对已存在的老安装文件补做。** 跨进程边界改动需要跨边界回归测试 + 负对照。
   证据：[PR #30 复审](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[PR #30 修复](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709323575)、[issue #36 裸赋值实测](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771691189)、[PR #38 chmod 600](https://github.com/GigleAI/cavil-loop/pull/38)。

6. **GitHub Project v2 看板字段写权限、仓库标签写权限、OAuth `project` scope 是三件互相独立的事**；权限不足应如实上报交人拍板，不擅自提权或静默跳过；ProjectV2 迭代字段变更不产生 timeline 事件，事后可能无法证实归因，报告中应明确写为未定论。
   证据：[PR #31 首条报告](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)、[PR #31 复审](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710415519)。

7. **根因排查、方案设计与问题复核都应对"看似显然"的假设做独立实测，不能只信读代码/文字描述，包括复审报告声称的具体后果。** 已验证案例：`exec 2>/dev/null` 永久重定向丢弃子进程 stderr；`git fetch` 被拒后 `git worktree add --force` 仍可能成功；PR #39 中开发方对"需人工介入"的严重性实测后更正为"自动恢复"。
   证据：[issue #34 方案](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769590395)、[PR #37 正文](https://github.com/GigleAI/cavil-loop/pull/37)、[issue #36 补充盘点](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771504273)、[PR #39 后果复核](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776234982)。

8. **校验、状态机与汇总类逻辑要系统性收口，而非逐点打补丁。** (a) "损坏时 fail-open"的数值校验须在所有"跳过/放行"判断之前统一执行；(b) 轮询状态机中"先记已处理、后做可能失败的读写"会让失败永久漏掉，读失败不得映射成具体状态；(c) 同一类问题被复审连续发现 3 次以上变体时，枚举该逻辑全部读、写、入队环节，并为每步配"首轮失败、下轮恢复"的跨轮测试及旧实现负对照；(d) 同源新增汇总指标（如 token 合计）须复用既有去重/认领/回退的同一份中间结果，用重叠、可重算、需回退三类样本做负对照；堆叠图的轴范围按叠加和断言，估算与重算分来源标注。
   证据：[PR #39 数值回绕](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5772835326)、[PR #39 收敛](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776234982)、[PR #44 汇总失败](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882325000)、[PR #44 漏入队](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882615439)、[PR #50 token 重复计入与轴上界](https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049612213)、[PR #50 修复](https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049668487)。
