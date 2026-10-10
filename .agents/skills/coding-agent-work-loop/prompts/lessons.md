# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

1. **面向人类的评论文本不得暴露内部状态码，金额/成本类展示需标注为"参考估算"而非"实际账单"。** 用量 footer 曾直接显示英文状态词 `full`，已改为中文说明，机器状态只留在隐藏 HTML 注释里；Codex 价格按公开标价换算，未与真实扣费核验，需标注核对日期。发布前自查是否有裸露内部术语或把估算包装成确定数字。
   证据：[PR #23 问题](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754)、[修复](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)。

2. **人工拍板可能以编辑原评论勾选 checkbox、文字答复、或仅 relabel（不留文字）出现，且同一 PR 内可能反复出现"只 relabel 不留文字"。** 复盘/审计须落到具体评论 URL、`created_at`/`updated_at` 和正文核对，不能凭"最新评论是自己发的"或"label 已翻回"推定已确认；无法核实就写"未见书面确认，按默认项/推断执行"。PR #48 中默认 A 的交付先于人工勾选，后来才补上书面确认，已如实披露；PR #57 的 Q1 同样只 relabel，按默认 A 执行。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[PR #39 relabel-only](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774321544)、[PR #26 Q1](https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-5726029814)、[PR #48 勾选后确认](https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6049807397)、[PR #57 Q1 按默认执行](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051531261)。

3. **独立复审要用对应阶段的标准（方案阶段审"值不值得看"，不得以"没实现/没测试"打回）；测试全绿、复审"实测通过"、PR 合并三者都不等价于"生产已实际执行该改动"，须分别声明。** "实测过的/没跑过的"分栏披露是值得延续的格式。PR #26、#50、#54、#59、#48、#57 合并时，真实数据重跑、部署执行、真实 daemon 续接均未验证。
   证据：[issue #34 复审误用标准](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769671286)、[PR #39 最终通过](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776318505)、[PR #48 复审](https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6049832545)、[PR #57 终审](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6052507710)。

4. **自指边界：修改复审/派工工具自身运行时依赖的脚本或模板时，验证结果天然存在版本滞后，需主动声明。** 技能目录软链接指向 main checkout，PR #27/#31/#37/#39/#44/#50/#48/#57 反复出现"合并前复审和派工仍用旧版"；PR #26 的受管 release 机制合并后此风险形态会变化，须真机验证后再更新本条。
   证据：[PR #27](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707594020)、[PR #50 修复评论](https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049668487)。

5. **涉及密钥的环境变量/配置有三类易忽视的失效模式：一次性覆盖参数复用持久配置同名变量会被 source 覆盖；裸赋值能否被子进程看到取决于此前是否 export 过（需全新变量名 + `env -u` 才能暴露）；安装脚本常未收紧密钥文件权限，需显式 `chmod 600` 并对老安装补做。** 跨进程边界改动需跨边界回归测试 + 负对照；daemon 新增写调用须走读写身份分离（`gh_write`），断言落在调用身份上。
   证据：[PR #30 复审](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[issue #36](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771691189)、[PR #26 身份遗漏](https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-6050113829)。

6. **GitHub Project v2 字段写权限、仓库标签写权限、OAuth `project` scope 三者互相独立**；权限不足应如实上报交人，不擅自提权或静默跳过；ProjectV2 迭代字段变更无 timeline 事件，事后可能无法归因，报告中写为未定论。
   证据：[PR #31 首条报告](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)。

7. **根因排查、方案设计与问题复核都应对"看似显然"的假设做独立实测，不能只信读代码/文字描述，包括复审报告声称的后果和文档中的运维承诺。** 已验证案例：`exec 2>/dev/null` 丢弃子进程 stderr；`git fetch` 被拒后 `git worktree add --force` 仍可能成功；PR #26 文档写的"回退"实测不可用；`claude --continue` 不带 `--model` 沿用旧会话模型（PR #57）。
   证据：[issue #34 方案](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769590395)、[PR #39 后果复核](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776234982)、[PR #26 回退实测](https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-5726029814)、[issue #56 方案](https://github.com/GigleAI/cavil-loop/issues/56#issuecomment-6051354261)。

8. **校验、状态机、并发、汇总与多处调用的逻辑要系统性收口，而非逐点打补丁。** (a) fail-open 校验须在所有放行判断之前统一执行；(b) 轮询状态机"先记已处理、后做可能失败的读写"会永久漏掉失败；(c) 同类问题被复审连续发现 3 次以上变体，就枚举全部读、写、入队环节并配跨轮测试及旧实现负对照；(d) 同源汇总复用同一份中间结果；(e) jq 与 Python 两份实现须用同输入逐字段比对；(f) 同一判定被多处调用时，端到端测试逐处断言并分别做负对照，断言行为而非源码写法；(g) 开 PR 前与合并前，把新测试跑在最新 base 上，避免与刚合并的 PR 重复（PR #48 与 #47）。合并 base 后须重新核对横切约定；开工后到达的人工口径变更可能使复审意见作废，提交前重读晚于上次提交的人工要求。
   证据：[PR #39 数值回绕](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5772835326)、[PR #44 汇总失败](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882325000)、[PR #54 第 2 轮](https://github.com/GigleAI/cavil-loop/pull/54#issuecomment-6050691045)、[PR #59 第 1 轮复审](https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052446031)、[PR #48 与 #47 的差异对照](https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013196195)、[PR #48 明细缺口](https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013473233)。

9. **需要得到外部工具（如 Claude CLI）的解析结果时，不要手工复刻其配置优先级或 shell 拆词；优先委托工具自己解析（无副作用探测），必须自己解析时用白名单，拿不准就不追加并记日志。** PR #57 手工复刻连续被复审发现漏了命令行参数、相对路径、worktree 本地配置位置，之后拆词又漏 `~` 与 `\~`，共 5 轮返工，其中两次触发三轮上限转人工。测试应使用真实 git worktree、daemon 与 worker 不同目录、两份不同取值的文件来区分路径，并对旧实现做负对照；新增运行时依赖（如 `timeout`）要与安装检查一致。适用于解析规则复杂或随版本变化的场景；探测有成本，须披露副作用与退路。
   证据：[复审第 1 轮](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051482658)、[改为问 CLI](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051898583)、[`~` 与 timeout](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051946208)、[`\~` 修复](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6052473544)。
