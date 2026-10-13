# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

`## 硬规则` 段的每一条都已在 3 个以上不同 PR 里出现过：worker 自审和交叉 review 必须逐条核对，适用而没做到的，review 打回。`## 观察中` 段是还没攒够次数的经验，适用时参考。编号永久不变；格式与计次规则见 `scripts/retrospective_lessons.py`。

计次来源：迁移到本格式时，每个 Seen 都回到该 PR 的复盘报告（`docs/retrospectives/pr-N.md`）核对过，只计报告写明「这个 PR 里出过这个问题」的——被引用、只是提到、做对了都不算；每一次的报告原文与行号见 `docs/retrospectives/lessons-migration.md`。之后的 Seen 由复盘程序按当次 PR 的评论证据追加。计次说明问题出现过，不证明每次都由同一原因造成。

<!-- next-id: 29 -->

## 硬规则

### L1
- 规则：复审对同一根因连续指出第 3 个变体时，停止逐点修补：枚举这段逻辑的全部输入、读、写与入队环节一次收口，配跨轮测试和旧实现负对照；仍收不住，就把「是否换设计」作为选择题交人。
- 适用：返工轮次里，复审指出的问题与前几轮同源时。
- 为什么：数值合法性、失败重试、会话归属、外部配置解析都曾各自返工 5 轮以上，每轮只补上一个变体。
- 这样做是对的：PR #39 改用写入方恒满足的不变式，取代逐字段清单；PR #57 从复刻规则改为直接问 CLI。
- Seen 4×: #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050467714 · #39 https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774726460 · #44 https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882615439 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6052366557

### L2
- 规则：根因排查、方案设计和复核复审意见时，先实测「看似显然」的前提（issue 里的现状描述、文档里的承诺、复审写的后果），再据此定方案或下结论。
- 适用：方案、根因分析、运维文档承诺，以及回应复审指出的问题。
- 为什么：issue 对现状的描述、文档写的「可回退」、复审写的「需人工介入」，都被实测推翻过。
- Seen 4×: #26 https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-5726029814 · #37 https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769590395 · #38 https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771504273 · #39 https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776234982

### L3
- 规则：同一条规则有多个实现或调用点（生产者与消费者、jq 与 Python、汇总与明细、新增指标与已有指标）时，复用同一个函数或同一份中间结果；做不到就用同一份输入对拍全部输出字段，并对每个调用点单独做负对照。
- 适用：计价、计数、去重、判断「是否已有值」这类在多处使用的规则。
- 为什么：新增的 token 合计绕过了金额的去重，补价器和读价方对日期后缀名判断不一致，补算漏掉了驱动已处理的分支，端到端测试只断言了一个计数位置。
- Seen 4×: #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013473233 · #50 https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049612213 · #55 https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050704401 · #59 https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052446031

### L4
- 规则：测试走真实执行路径和真实形状——真实子进程边界、仓库自带的多行模板与真实日志结构、真实目录布局（如 git worktree）——并断言行为，不断言源码文本或调用文本。
- 适用：新增或修改测试。
- 为什么：只在测试进程内匹配源码的测试在 bug 存在时仍全绿；单行夹具绕过了多行 prompt 的缺陷；普通临时目录测不出 worktree 和 `~` 展开的差异；禁止某种源码写法的断言误报。
- Seen 4×: #30 https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794 · #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050298312 · #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013196195 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051560673

### L5
- 规则：合并 base 之后，列出 base 新增的横切约定（写身份、命令行参数、路径写法等），逐一核对它们落到了本 PR 新增的代码路径上；git 没报冲突不等于没有遗漏。
- 适用：PR 合并或 rebase 过 base 之后。
- 为什么：合并后漏了读写身份分离（`gh_write`）、`--no-daemon` 和 `$SELF_DIR`，三次都没有冲突标记。
- Seen 3×: #26 https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-6050113829 · #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6000581168 · #55 https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6051366296

## 待确认

## 观察中

### L6
- 规则：依赖外部工具的解析结果或落盘格式时，委托工具自己解析（无副作用探测），或先读一份真实产物再写解析；必须自己解析时用白名单，拿不准就不处理并记日志。
- Seen 2×: #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050504716 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051898583

### L7
- 规则：「值是怎么得到的」（重算 / 回退 / 补算）、「用的哪种来源」（内置 / 人工 / 自动抓取）和「可信状态」分开记录，一路传到最终展示，不合并成一个字段。
- Seen 2×: #55 https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050606749 · #59 https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052642580

### L8
- 规则：新增或修改的测试先在旧实现或错误变体上跑一遍，确认会变红；样本要能区分错误实现。
- Seen 2×: #50 https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049612213 · #59 https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052642580

### L9
- 规则：判定人工是否已拍板，落到具体评论 URL、`created_at` / `updated_at` 和正文核对（勾选、文字答复、只改 label 都可能是拍板），不凭「最新评论是自己发的」或「label 已翻回」推定；只有 relabel 时写「未见书面确认，按默认项执行」，查不到勾选编辑者就写「出自谁未验证」。
- 适用：复盘、审计、派工判断人工意图时。
- Seen 1×: #30 https://github.com/GigleAI/cavil-loop/pull/30

### L10
- 规则：修改复审 / 派工工具自身运行时依赖的脚本或模板时，在交付说明的显著位置声明「合并部署前，复审和派工仍用旧版」带来的验证滞后。
- 适用：改到 daemon、prompt 模板、driver 等会被本次 review 自己用到的文件。
- Seen 1×: #27 https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707826052

### L11
- 规则：测试全绿、复审「实测通过」、PR 合并、生产已实际执行这几件事分别声明，不互相代替；「实测过的 / 没跑过的」分栏披露。
- 适用：交人评论、复审结论、复盘里提到验证或上线状态。
- Seen 0×:

### L12
- 规则：面向人的评论不暴露内部状态码，金额 / 成本类展示标注为「参考估算」而不是「实际账单」。
- Seen 1×: #23 https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754

### L13
- 规则：不用评论轮数推算调用次数、token 或耗时来源，缺数据就写无法量化。
- Seen 0×:

### L14
- 规则：独立复审用对应阶段的标准：方案阶段审「值不值得看」，不得以「没实现 / 没测试」打回。
- Seen 1×: #37 https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769671286

### L15
- 规则：一次性覆盖值传给会重新加载配置的子进程时，不复用持久配置里的同名变量，在配置加载之后再应用覆盖。
- Seen 1×: #30 https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794

### L16
- 规则：验证「某个变量子进程看不看得到」时，用环境里从未出现过的变量名并 `env -u` 清空后再测；配置文件里不带 export 的变量要显式传给子进程。
- Seen 1×: #38 https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771691189

### L17
- 规则：安装脚本对存放密钥的文件显式 `chmod 600`，新建和已存在两种情况都要处理（已存在的不覆盖内容）。
- Seen 1×: #38 https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771632056

### L18
- 规则：GitHub 写入被拒时，分别核对 OAuth scope 和账号对该具体资源（看板、仓库）的权限；权限不足如实上报交人，不擅自提权或静默跳过。
- Seen 1×: #31 https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750

### L19
- 规则：会话 / 资源的归属靠正向证据（自发 id、接管前快照、与本次启动绑定的唯一标记），举证不了就拒绝并留诊断，不靠「当前没登记给别人」「启动后才出现」「首行相同」这类排除法或出现顺序。
- 这样做是对的：真实形状夹具（多行模板、前置上下文消息、两个角色方向）加逐入口单点负对照。
- Seen 1×: #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6000725005

### L20
- 规则：合法值可能为 0 的字段，判断「缺失」用显式空值判断（`is not None`），不用真假判断。
- Seen 1×: #55 https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050606749

### L21
- 规则：开 PR 前和合并前，把新测试跑在最新 base 上，区分本 PR 与近期合并的 PR 是重复还是增量。
- Seen 1×: #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013168159

### L22
- 规则：与 base 同时在文件末尾追加函数并合并后，检查两边共用的结尾行（如 `return 0` / `}`）没有被合并丢失。
- Seen 1×: #55 https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6051655505

### L23
- 规则：fail-open 的状态校验放在所有可能返回「跳过」的判断之前统一执行。
- Seen 1×: #39 https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5773080176

### L24
- 规则：轮询状态机只在所有写入确认成功后才记「已处理」，不先记已处理、后做可能失败的读写。
- Seen 1×: #44 https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882325000

### L25
- 规则：读取失败不映射成某个具体状态（如 `|| echo OPEN`），按「未知」处理并留待下轮重试。
- Seen 1×: #44 https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882756411

### L26
- 规则：下「全部完成」的结论前，先确认列表完整：当前项在列表内、条数与来源总数一致。
- Seen 1×: #44 https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882462036

### L27
- 规则：每次动手改之前，按时间重读晚于上次提交的人工要求；开工后到达的口径变更可能让当前复审意见作废。
- Seen 1×: #54 https://github.com/GigleAI/cavil-loop/pull/54#issuecomment-6050691045

### L28
- 规则：负对照变红后确认红的原因是语义退回，而不是补丁语法错误。
- Seen 1×: #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6051479059
