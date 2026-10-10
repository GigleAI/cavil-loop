# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

1. **面向人类的评论文本不得暴露内部状态码，金额/成本类展示需标注为"参考估算"而非"实际账单"。** 用量 footer 曾直接显示英文状态词 `full`，已改为中文说明，机器状态只留在隐藏 HTML 注释里；Codex 价格按公开标价换算，未与真实扣费核验。发布前自查是否有裸露内部术语或把估算包装成确定数字。不得用评论轮数推算调用次数、token 或耗时来源；缺数据就写无法量化。
   证据：[PR #23 问题](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754)、[修复](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)。

2. **人工拍板可能以编辑原评论勾选 checkbox、文字答复、或仅 relabel（不留文字）出现。** 复盘/审计须落到具体评论 URL、`created_at`/`updated_at` 和正文核对，不能凭"最新评论是自己发的"或"label 已翻回"推定已确认；API 查不到勾选编辑者时写"出自谁未验证"；无法核实就写"未见书面确认，按默认项/推断执行"。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[PR #39 relabel-only](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774321544)、[PR #48 勾选后确认](https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6049807397)、[PR #57 Q1 按默认执行](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051531261)、[issue #32 勾选](https://github.com/GigleAI/cavil-loop/issues/32#issuecomment-5710511044)。

3. **独立复审要用对应阶段的标准（方案阶段审"值不值得看"，不得以"没实现/没测试"打回）；测试全绿、复审"实测通过"、PR 合并三者都不等价于"生产已实际执行该改动"，须分别声明。** "实测过的/没跑过的"分栏披露值得延续。PR #26、#33、#48、#50、#54、#57、#59 合并时，真实 daemon 全链路、真实 codex 模型层、部署执行均未验证。
   证据：[issue #34 复审误用标准](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769671286)、[PR #39 最终通过](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776318505)、[PR #57 终审](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6052507710)、[PR #33 通过](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6051519757)。

4. **自指边界：修改复审/派工工具自身运行时依赖的脚本或模板时，验证结果天然存在版本滞后，需主动声明。** 技能目录软链接指向 main checkout，PR #27/#31/#37/#39/#44/#48/#50/#57 反复出现"合并前复审和派工仍用旧版"；PR #26 的受管 release 机制合并后风险形态会变化，须真机验证后再更新本条。
   证据：[PR #27](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707594020)、[PR #50 修复评论](https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049668487)、[PR #33 通过评论](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6051519757)。

5. **权限与密钥有多种互相独立的失效模式。** 密钥环境变量：一次性覆盖参数复用持久配置同名变量会被 source 覆盖；裸赋值能否被子进程看到取决于是否 export 过（需全新变量名 + `env -u` 暴露）；安装脚本常未收紧密钥文件权限，需显式 `chmod 600` 并对老安装补做。跨进程边界改动需跨边界回归测试 + 负对照；daemon 新增写调用须走读写身份分离（`gh_write`）。GitHub Project v2 字段写权限、仓库标签写权限、OAuth `project` scope 互相独立；权限不足如实上报交人，不擅自提权或静默跳过。
   证据：[PR #30 复审](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[issue #36](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771691189)、[PR #26 身份遗漏](https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-6050113829)、[PR #31](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750)。

6. **根因排查、方案设计与问题复核都应对"看似显然"的假设做独立实测；依赖外部工具的解析结果时，优先委托工具自己解析（无副作用探测），不手工复刻其优先级、拆词或落盘格式。** 已验证案例：`exec 2>/dev/null` 丢弃子进程 stderr；`git fetch` 被拒后 `git worktree add --force` 仍可能成功；`claude --continue` 不带 `--model` 沿用旧会话模型；PR #57 手工复刻 CLI 配置解析共 5 轮返工；PR #33 中 claude 目录编码漏字符、真实 codex 日志首条 user 消息是 AGENTS 指令。必须自己解析时先读一份真实产物，用白名单，拿不准就不追加并记日志。
   证据：[issue #34 方案](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769590395)、[PR #26 回退实测](https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-5726029814)、[PR #57 改为问 CLI](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051898583)、[PR #33 真实事件顺序](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6051479059)。

7. **校验、状态机、并发、汇总与多处调用的逻辑要系统性收口，而非逐点打补丁。** (a) fail-open 校验须在所有放行判断之前统一执行；(b) 轮询状态机"先记已处理、后做可能失败的读写"会永久漏掉失败；(c) 同类问题被复审连续发现 3 次以上变体，就枚举全部读、写、入队环节并配跨轮测试及旧实现负对照，必要时把"是否收敛设计"明确交人；(d) 同源汇总复用同一份中间结果；(e) jq 与 Python 两份实现用同输入逐字段比对；(f) 同一判定被多处调用时逐处断言并分别做负对照；(g) 开 PR 与合并前把新测试跑在最新 base 上，合并 base 后重新核对横切参数是否落到新增代码路径（git 无冲突标记不代表无遗漏，PR #33 的 `--no-daemon`）；开工后到达的人工口径变更可能使复审意见作废。负对照须确认红来自语义退回而非语法错误。
   证据：[PR #39](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5772835326)、[PR #44](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882325000)、[PR #54](https://github.com/GigleAI/cavil-loop/pull/54#issuecomment-6050691045)、[PR #59](https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052446031)、[PR #48 与 #47](https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013196195)、[PR #33 合并 main 缺口](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6000581168)。

8. **会话/资源的归属要靠正向证据，不能靠排除法或出现顺序。** 多角色共用同一 worktree 与历史库时，"当前没登记给别人""启动后才出现""首行/前 200 字节相同"都不能证明"这条是我的"，既会串角色，也会让自己的会话被静默拒绝、复用失效。适用条件：任何向注册表写入、认领或收养会话的入口。做法：逐个列出写入口并写明各自证据（自发 id、接管前快照、与本次启动绑定的唯一标记），举证不了就拒绝并留诊断；验证用真实形状夹具（多行模板、前置上下文消息、两个角色方向）加逐入口单点负对照。PR #33 因此返工约 8 轮复审、两次触顶转人工，作者曾提出"每次新开、不复用"的简化方案作为备选，不是唯一正确架构。
   证据：[force_new 孤儿化](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-5726098273)、[回捞串角色](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6000725005)、[多行与前缀](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050298312)、[前置 AGENTS 消息](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050504716)、[最终修复](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6051479059)。
