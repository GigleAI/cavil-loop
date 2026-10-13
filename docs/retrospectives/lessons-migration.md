# 项目经验迁移表：旧「8 大条」→ 按 PR 计次的规则

本文件记录 `.agents/skills/coding-agent-work-loop/prompts/lessons.md` 迁移到计次格式时，每一个 Seen 的出处。只在迁移时写一次；之后的 Seen 由复盘程序追加，出处是当次 PR 的评论链接，不再记在这里。

## 计次口径

- **一个 Seen = 该 PR 的复盘报告写明「这个 PR 里出过这个问题」**：本 PR 引入的，或本 PR 过程中发现的既有缺陷都算；被引用、只是提到、按规则做对了都不算。这与复盘程序对新 Seen 的要求一致（`prompts/retrospective.template.md`：「确实说明本 PR 犯了这个错（被引用、只是提到不算）」）。
- **按 PR 计，不按 issue 计**：复盘一个 PR 一次，所以旧条目里引用的 issue 号换成它对应的 PR（#22→#23、#28→#30、#29→#31、#32→#33、#34→#37、#36→#38、#51→#55）。
- **一处原文只计给一条规则**：同一句报告原文不重复计到两条规则上；报告把两件事分开列为两条教训的，才可以各计一次。
- 报告原文的行号指 `main` 上 `docs/retrospectives/pr-N.md`（迁移时的版本，`ae7fe65`）。链接是报告里引用的、能说明这件事的那条评论。
- 只有 17 个 PR 有复盘报告（#23 #26 #27 #30 #31 #33 #37 #38 #39 #44 #48 #50 #53 #54 #55 #57 #59）。没有报告的 PR / issue 不计。

## 硬规则（≥ 3 次）

### L1 同一根因第 3 个变体时停止逐点修补（来自旧第 7 条 (c)）

| PR | 报告原文 | 证据链接 |
|---|---|---|
| #33 | pr-33.md:64「同一根因被连续发现多次后，应重新评估设计……每轮仍在边界上继续打补丁」；:97 作者自述是同一根因的第 4–7 个变体 | [#33 第 2 次修复](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050467714) |
| #39 | pr-39.md:29「返工原因：初版「状态坏了就该跑」的防护，是按发现顺序逐点打补丁……5 轮修复都属于同一类问题的不同变体」 | [#39 改用不变式](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774726460) |
| #44 | pr-44.md:44「逐点修补会多轮返工……该次枚举没有覆盖上游的读取和入队环节」 | [#44 第 2 轮复审](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882615439) |
| #57 | pr-57.md:39「会被逐点发现遗漏。复审连续 3 轮发现同类变体后，才从「补规则」改成「问权威方」」 | [#57 第 5 轮复审](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6052366557) |

阈值：沿用旧第 7 条的「连续发现 3 次以上变体」。上一版迁移曾改成「第二次变体」（取自 pr-57.md:216 一条**尚未实施**的建议），没有依据，已改回。

### L2 先实测「看似显然」的前提（来自旧第 6 条前半）

| PR | 报告原文 | 证据链接 |
|---|---|---|
| #26 | pr-26.md:24「文档承诺须按实测校验："可回退"未经实测即写入文档，被人工追问后才发现不成立」 | [#26 回退实测](https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-5726029814) |
| #37 | pr-37.md:26「设计阶段先实测再定方案，推翻了两个「想当然」的假设」（stderr 去向、`worktree add --force`） | [issue #34 方案](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769590395) |
| #38 | pr-38.md:24「不轻信 issue 自带的现状盘点……发现 daemon 除翻 label 外还有两处写」 | [issue #36 方案](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771504273) |
| #39 | pr-39.md:30「review 认定「缺陷属实」不等于其描述的「后果严重性」也准确——实测证明复审报告的具体后果被高估」 | [#39 更正记录](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776234982) |

### L3 同一规则的多个实现 / 调用点复用同一入口或对拍（来自旧第 7 条 (d)(e)(f)）

| PR | 报告原文 | 证据链接 |
|---|---|---|
| #48 | pr-48.md:30「端到端测试有多个计数位置时，只断言一处会留下盲区……「判定函数有单测」不等于「所有调用点都用了它」」 | [#48 第 2 轮复审](https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013473233) |
| #50 | pr-50.md:35「新增汇总指标容易绕过已有的去重规则……同一事实的不同度量应共用一个取数入口」 | [#50 第 1 轮复审](https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049612213) |
| #55 | pr-55.md:26「「有价」的判定在多个组件间不一致……都是「生产者与消费者各自实现同一判定」」（日期后缀名） | [#55 第 2 轮复审](https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050704401) |
| #59 | pr-59.md:35「同一规则有两份实现时，分别断言数字不够……第 1 轮漏了 3 类分支」 | [#59 第 1 轮复审](https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052446031) |

#55 的零值问题（真假判断吞掉 $0）是另一类错，单列 L20；#55 / #59 的「来源与可信状态合并」单列 L7。

### L4 测试走真实路径与真实形状，断言行为（来自旧第 5 条「跨边界回归」、第 8 条「真实形状夹具」）

| PR | 报告原文 | 证据链接 |
|---|---|---|
| #30 | pr-30.md:34「同批新增的回归测试……只在当前 shell 内读变量、匹配源码字符串，没有真正跨越 dispatch 会重新 source 配置的子进程边界……在 bug 存在的情况下依然报告 11/11」 | [#30 第 1 轮复审](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794) |
| #33 | pr-33.md:57「测试夹具必须取自真实形状。短单行 prompt、把任务放在第一条 user 消息，都绕过了缺陷」 | [#33 多行与前缀](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050298312) |
| #48 | pr-48.md:29「「测试里禁止 `def is_bot`」这类过死的结构性断言会误报。应断言行为或对象同一性，不要断言源码写法」 | [#48 对照](https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013196195) |
| #57 | pr-57.md:40「目录、`~` 展开和转义语义都可能不同。测试只用普通临时目录和绝对路径，抓不到这些差异」 | [#57 第 2 轮复审](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051560673) |

#30 的「同名变量被覆盖」本身是另一条报告原文（pr-30.md:30），单列 L15。

### L5 合并 base 后核对横切约定落到新代码路径（来自旧第 7 条 (g)、第 5 条 `gh_write`）

| PR | 报告原文 | 证据链接 |
|---|---|---|
| #26 | pr-26.md:23「合并 main 引入新约定（读写身份分离）会让「测试全绿」失效……实际漏了该维度」 | [#26 写身份遗漏](https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-6050113829) |
| #33 | pr-33.md:65「合并 main 后要检查新增的横切参数是否落到新代码路径上。git 自动合并不会提示这类遗漏」；:102 漏了 `--no-daemon` | [#33 合并 main 缺口](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6000581168) |
| #55 | pr-55.md:16「顺带发现 codex 脚本新增行未跟 main 的 `$SELF_DIR` 写法，经符号链接调用会失败」 | [#55 第一次解冲突](https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6051366296) |

旧第 5 条里「daemon 新增写调用走 `gh_write`」唯一一次出现就是上面 #26 这一条，已并入 L5 的「为什么」，不再单列（`AGENTS.md` 本身已有这条约定）。

## 观察中（< 3 次）

| 编号 | 规则（简） | 来自旧条目 | 计入 | 报告原文 | 证据链接 |
|---|---|---|---|---|---|
| L6 | 委托工具解析 / 先读真实产物 | 6 后半 | #33 | pr-33.md:59、:71 真实 rollout 第一条 user 消息是 AGENTS 指令；「外部 CLI 的落盘格式不受自己控制……先读一份真实产物」 | [#33](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050504716) |
| | | | #57 | pr-57.md:39「复刻外部工具的优先级或解析规则，会被逐点发现遗漏」 | [#57](https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051898583) |
| L7 | 来源 / 方法 / 可信状态分开记 | 7 (f) | #55 | pr-55.md:27「冲突与「来自自动抓取」是两个独立维度，合并成一个桶会丢信息」 | [#55](https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050606749) |
| | | | #59 | pr-59.md:37「「如何得到」与「用的哪种来源」是两个维度。合并为一个字段会抹掉可信度归属」 | [#59](https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052642580) |
| L8 | 测试先在旧实现上变红 | 7 | #50 | pr-50.md:38「初版测试样本太窄……区分不了错误实现」 | [#50](https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049612213) |
| | | | #59 | pr-59.md:38「真实链路上的测试可能区分不出错误实现……在旧代码上也绿」 | [#59](https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052642580) |
| L9 | 拍板要落到评论与时间戳 | 2 | #30 | pr-30.md:12「Issue #28 只有一条评论……未在证据中看到人工在该方案下的显式文字确认……body 称「issue #28 已确认」」（issue #28 timeline 只有 relabel） | [PR #30 body](https://github.com/GigleAI/cavil-loop/pull/30) |
| L10 | 显著声明自指滞后 | 4 | #27 | pr-27.md:27「复审虽然在文字中提到了这一限制，但没有在结论首行/摘要处显著提示，最终靠人工主动追问才澄清」 | [#27 人工提问](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707826052) |
| L11 | 测试 / 复审 / 合并 / 生产分别声明 | 3 后半 | — | 0 次：各报告都写明这些已分别声明，没有混为一谈的记录 | — |
| L12 | 不暴露状态码，金额标估算 | 1 前半 | #23 | pr-23.md:37「技术状态码不应该直接暴露给非工程背景的评论读者」 | [#23](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754) |
| L13 | 不从评论轮数推算用量 | 1 后半 | — | 0 次：各报告都遵守了，没有违反的记录 | — |
| L14 | 复审用对应阶段的标准 | 3 前半 | #37 | pr-37.md:39「复审第 1 轮的判定标准与项目自身 review 模板存在冲突」 | [issue #34 复审](https://github.com/GigleAI/cavil-loop/issues/34#issuecomment-5769671286) |
| L15 | 一次性覆盖值不复用同名变量 | 5 | #30 | pr-30.md:30「根因是环境变量命名冲突」 | [#30](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794) |
| L16 | 变量可见性用新名字 + `env -u` 测 | 5 | #38 | pr-38.md:33「复用已被 ambient 环境预先 export 过的变量名，会掩盖真实的失效路径」 | [issue #36](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771691189) |
| L17 | 安装脚本 `chmod 600` 密钥文件 | 5 | #38 | pr-38.md:34「涉及密钥的配置文件权限治理容易被安装脚本遗漏」 | [issue #36](https://github.com/GigleAI/cavil-loop/issues/36#issuecomment-5771632056) |
| L18 | scope 与资源权限分别核对 | 5 | #31 | pr-31.md:28–30 写入被拒：PAT 有 `project` scope，但账号对该看板 `viewerCanUpdate: false` | [#31](https://github.com/GigleAI/cavil-loop/pull/31#issuecomment-5710284750) |
| L19 | 归属靠正向证据 | 8 | #33 | pr-33.md:54「归属要靠正向证据」 | [#33](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6000725005) |
| L20 | 零值用显式空值判断 | 7 (f) | #55 | pr-55.md:26「真假判断吞掉 $0」 | [#55](https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050606749) |
| L21 | 新测试跑在最新 base 上 | 7 (g) | #48 | pr-48.md:28「并行重叠的工作没有被及时发现……开工前或开 PR 前对照 base 的最新合并 PR，可以更早发现」 | [#48 人工提问](https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013168159) |
| L22 | 末尾追加函数合并后查共用结尾行 | 7 (g) | #55 | pr-55.md:30「文本合并可能静默丢失共用的结尾行」 | [#55](https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6051655505) |
| L23 | fail-open 校验放在跳过判断之前 | 7 (a) | #39 | pr-39.md:17「`last_active`/`fail_streak` 校验时机太晚（在「是否跳过」判定之后才兜底），损坏状态仍会被跳过一轮」 | [#39](https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5773080176) |
| L24 | 写入全部成功后才记已处理 | 7 (b) | #44 | pr-44.md:38–39「对「已完成」的记录必须以「所有写入被确认成功」为条件……先把 PR 或任务标为已处理，再做可能失败的读写」 | [#44](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882325000) |
| L25 | 读失败不映射成具体状态 | 新拆 | #44 | pr-44.md:41「读失败不能映射成一个具体状态」 | [#44](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882756411) |
| L26 | 下「全部完成」前确认列表完整 | 新拆 | #44 | pr-44.md:23「子项列表缺项时提前汇总」 | [#44](https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882462036) |
| L27 | 动手前重读最新人工口径 | 7 | #54 | pr-54.md:32「开工后到达的需求转达可能让当前复审意见作废」 | [#54](https://github.com/GigleAI/cavil-loop/pull/54#issuecomment-6050691045) |
| L28 | 负对照的红要来自语义退回 | 7 | #33 | pr-33.md:61「负对照必须确认红的原因是语义退回，而不是语法错误」 | [#33](https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6051479059) |

## 旧条目引用了、但这次没有计入的 PR

旧格式按「这条经验引用过哪些 PR」计次，下面这些引用都没有过「报告写明出过这个错」这一关：

| 旧条目 | 引用的 PR | 没计的原因 |
|---|---|---|
| 3 后半（测试 / 合并 / 生产分别声明，现 L11） | #26 #33 #48 #50 #54 #55 #57 #59 | 报告写的是「本 PR 已分别声明、未验证项已披露」，是做对了，不是犯错 |
| 4（自指滞后，现 L10） | #31 #37 #39 #44 #48 #50 #55 #57 | 报告写的是滞后存在、且 PR 已主动声明；只有 #27 是没有显著声明、靠人追问才澄清 |
| 2（拍板核对，现 L9） | #22(#23) #39 #48 #57 #32(#33) #51(#55)，以及 #38 #44 #53 | 报告写的都是「已如实标注为推断 / 按默认执行」，是做对了；#23 报告明说「未见处理失误」 |
| 7（系统性收口） | #47 | 没有复盘报告（#47 的问题出现在 #48 的报告里，已按 #48 计） |
| 5（权限与密钥） | #26（`gh_write`） | 同一处原文已计入 L5，不重复计 |
| — | #26 r1–r3 状态 / 并发组合路径 | pr-26.md:22 归为同一成因，但没说是「同一根因的变体被逐点修补」，不计入 L1 |
| — | #53 | 报告：没有返工、没有出现上述问题 |

## 和上一版迁移的差别

上一版（`9fd2fa4`）把旧条目引用过的 PR 号直接当作出现次数，所以出现了 L2 9 次、L1 8 次这样的数。本版逐条回到报告核对后：

| 规则 | 上一版 | 本版 |
|---|---|---|
| 自指滞后 | 硬规则，9× | 观察中，1×（L10） |
| 测试 / 合并 / 生产分别声明 | 硬规则，8× | 观察中，0×（L11） |
| 系统性收口 | 硬规则，6×，阈值写成「第二次变体」 | 硬规则，4×，阈值改回「第 3 个变体」（L1） |
| 拍板核对 | 硬规则，6× | 观察中，1×（L9） |
| 先实测前提 | 观察中，2× | 硬规则，4×（L2） |
| 多处实现复用同一入口 | 观察中，1× | 硬规则，4×（L3） |
| 测试走真实路径与形状 | 不是单独一条 | 硬规则，4×（L4） |
| 合并 base 后核对横切约定 | 观察中，2× | 硬规则，3×（L5） |
