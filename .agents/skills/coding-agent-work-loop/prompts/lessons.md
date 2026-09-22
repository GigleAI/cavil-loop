# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

1. **面向人类的评论文本不得暴露内部状态码，金额/成本类展示需标注为"参考估算"而非"实际账单"。** 用量 footer 曾直接显示英文状态词 `full`，已改为中文人话说明，机器状态只留在隐藏 HTML 注释里；Codex 价格按官方公开标价换算，未与真实扣费核验，需标注核对日期、显式配置可整表覆盖、`{}` 可关闭估算。发布前需自查是否有裸露的内部术语或把估算包装成确定数字。
   证据：[PR #23 问题](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754)、[修复](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)、[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)。

2. **人工拍板可能以编辑原评论勾选 checkbox、直接文字答复、或仅靠 relabel（不留文字）三种方式出现，且同一 PR 内可能反复出现"只 relabel 不留文字"。** 复盘/审计时须落到具体评论 URL、`created_at`/`updated_at` 和正文核对，不能只凭"最新评论是自己发的"或"label 已翻回"推定已确认；无法核实时须在报告中明确写"未见书面确认，按默认项/推断执行"。PR #39 中人工在设计阶段有 3 条实质文字回复，但进入密集 review-fix 循环后两次仅移除 `pending/human` 标签、全程无文字，agent 均如实标注为推断并请求人工纠正。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[issue #28](https://github.com/GigleAI/cavil-loop/issues/28#issuecomment-5709122169)、[PR #37 文字确认](https://github.com/GigleAI/cavil-loop/pull/37#issuecomment-5771186863)、[issue #35 设计阶段实质回复](https://github.com/GigleAI/cavil-loop/issues/35#issuecomment-5771679372)、[PR #39 relabel-only 两次](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774321544)、[PR #39 第二次](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776234982)。

3. **独立复审要用对应阶段的标准（方案阶段审"值不值得看"，不得以"没实现/没测试"打回代码阶段的标准）；沙盘/单元测试全绿、复审自陈"实测通过"、PR 合并动作三者互不等价于"生产环境已实际执行该改动"，须分别声明。** PR #39 正文用"实测过的/负对照"两栏披露验证范围，并明确写"沙盘全绿 ≠ 生产 daemon 跑通""合并当天大概率看不到效果变化"，是值得延续的诚实披露格式。
   证据：[PR #23 复审](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5690315790)、[issue #34 复审误用标准](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769671286)、[PR #39 正文验证章节](https://github.com/GigleAI/cavil-loop/pull/39)、[PR #39 最终通过](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776318505)。

4. **自指边界：修改 CI/复审工具自身运行时依赖的基础设施脚本时，验证结果天然存在版本滞后，需主动声明，不能等被质疑才解释。** 本项目技能目录软链接指向 main checkout，已连续在 4 个 PR（#27 #31 #37 #39）中出现"改的就是复审自己要用的脚本，合并前复审看到的仍是旧版行为"，应视为固定风险点而非偶发 bug。
   证据：[PR #27](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707594020)、[PR #31](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)、[PR #37 正文](https://github.com/GigleAI/cavil-loop/pull/37)、[PR #39 正文边界声明](https://github.com/GigleAI/cavil-loop/pull/39)。

5. **涉及密钥的环境变量/配置文件有三类易被忽视的失效模式：一次性覆盖参数复用持久配置同名变量会被 source 覆盖；配置文件"裸赋值"能否被子进程看到取决于此前是否已被 export 过（需用全新变量名 + `env -u` 清空环境才能暴露）；安装脚本常未强制收紧密钥文件权限，需显式 `chmod 600` 并对已存在的老安装文件补做。跨进程边界改动需要跨边界回归测试 + 负对照。**
   证据：[PR #30 复审](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[PR #30 修复](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709323575)、[issue #36 裸赋值实测](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771691189)、[PR #38 chmod 600](https://github.com/GigleAI/cavil-loop/pull/38)。

6. **GitHub Project v2 看板字段写权限、仓库标签写权限、OAuth `project` scope 是三件互相独立的事**；权限不足应如实上报交人拍板，不擅自提权或静默跳过；ProjectV2 迭代字段变更不产生 timeline 事件，事后可能无法证实归因，报告中应明确写为未定论。
   证据：[PR #31 首条报告](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)、[PR #31 复审](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710415519)。

7. **根因排查、方案设计与问题复核都应对"看似显然"的假设做独立实测，不能只信读代码/文字描述，包括复审报告本身声称的具体后果。** 已验证案例：`exec 2>/dev/null` 永久重定向丢弃子进程 stderr；`git fetch` 拒绝后紧跟的 `git worktree add --force` 仍可能成功造成双 worktree 冲突；issue 正文自带的"现状盘点"可能遗漏关键写入路径，需重新读代码核实。PR #39 中，开发方对 review 认定"属实"的缺陷仍独立实测其声称的具体后果（"需人工介入"实测为"自动恢复"），并在评论中如实更正，而非全盘照搬 review 的严重性描述。
   证据：[issue #34 方案](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769590395)、[PR #37 正文](https://github.com/GigleAI/cavil-loop/pull/37)、[issue #36 补充盘点](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771504273)、[PR #39 后果复核与更正](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776234982)。

8. **"状态损坏时 fail-open"类安全边界，数值校验须在所有可能返回"跳过/放行"的判断之前统一执行，覆盖字符类、位数上限（防 bash 算术静默回绕成合法值）、进制（防前导零被当八进制解析）三个维度；闸门调用方式本身应做成结构性 fail-open（内部异常也等于放行），不能依赖调用方错误处理路径恰好正确。同一类问题被同一复审流程连续发现 3 次以上变体时，应转为枚举该逻辑涉及的全部输入维度做系统性收口（如改用"写入方恒满足的数学不变式"判定合法性），而不是继续逐点打补丁。**
   证据：[PR #39 数值回绕](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5772835326)、[校验时机太晚](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5773080176)、[字段间不变式](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774424973)、[前导零八进制](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774817905)、[收敛为闭包不变式+结构性fail-open](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776234982)。
