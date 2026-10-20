# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

`## 硬规则` 段的每一条都已在 3 个以上不同 PR 里出现过：worker 自审和交叉 review 必须逐条核对，适用而没做到的，review 打回。`## 观察中` 段是还没攒够次数的经验，适用时参考。编号永久不变；格式与计次规则见 `scripts/retrospective_lessons.py`。

计次来源：只计复盘报告（`docs/retrospectives/pr-N.md`）写明「这个 PR 里出过这个问题」的；被引用、只是提到不算；当事人按规则自己查出、交付前就改掉的记进「这样做是对的」，不计次。迁移时每一次的报告原文与行号见 `docs/retrospectives/lessons-migration.md`。计次说明问题出现过，不证明每次由同一原因造成。

为满足复盘 8 条上限，本版仅保留硬规则与高价值观察项，其余低频观察项（L6–L8、L10、L12–L28）已移出共享文件，历史见迁移表。

<!-- next-id: 31 -->

## 硬规则

### L1
- 规则：复审对同一根因连续指出第 3 个变体时，停止逐点修补：枚举这段逻辑的全部输入、读、写与入队环节一次收口，配跨轮测试和旧实现负对照；仍收不住，就把「是否换设计」作为选择题交人。
- 适用：返工轮次里，复审指出的问题与前几轮同源时。
- 为什么：数值合法性、失败重试、会话归属、外部配置解析都曾各自返工 5 轮以上，每轮只补上一个变体。
- 这样做是对的：PR #39 改用写入方恒满足的不变式；PR #57 从复刻规则改为直接问 CLI。
- Seen 4×: #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050467714 · #39 https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774726460 · #44 https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882615439 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6052366557

### L3
- 规则：同一条规则有多个实现或调用点（生产者与消费者、jq 与 Python、汇总与明细、多个交付入口）时，复用同一个函数、同一份文字或同一份中间结果；做不到就用同一份输入对拍全部输出，并对每个调用点单独做负对照。
- 适用：计价、计数、去重、判断「是否已有值」，以及要求同时写进多份 prompt 模板时。
- 为什么：新增 token 合计绕过金额去重，补价器与读价方判断不一致；PR #62 的自审表最初只接到返工入口，漏了首次开 PR 和子 issue；PR #72 的路径选择有对拍，但管理端、启动端、systemd 单元对同一端口登记各按不同依据取源，共存状态下漏归属。
- 这样做是对的：PR #64 把同一段文字写进三份 worker 指令和 review 附加指令，测试走真实拼装函数对拍成品，并对 7 个写入点逐个做负对照。PR #72 返工后认主、列表、注销共用同一枚举函数，端口锁共用，启动读单元绑定的登记，并对上一版逐检查点做负对照。
- Seen 5×: #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013473233 · #50 https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049612213 · #55 https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050704401 · #59 https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052446031 · #72 https://github.com/GigleAI/cavil-loop/pull/72#issuecomment-6283696025

### L4
- 规则：测试走真实执行路径和真实形状——真实子进程边界、仓库自带的多行模板与真实日志结构、真实目录布局（如 git worktree）——并断言行为，不断言源码文本。
- 适用：新增或修改测试。
- 为什么：只匹配源码的测试在 bug 存在时仍全绿；单行夹具绕过多行 prompt 缺陷；普通临时目录测不出 worktree 差异。
- 这样做是对的：PR #64 的新测试读仓库真实多行模板，调用派工真正使用的拼装函数，断言合成后的指令内容。
- Seen 4×: #30 https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794 · #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050298312 · #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013196195 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051560673

## 待确认

## 观察中

### L2
- 规则：根因排查、方案设计和复核复审意见时，先实测「看似显然」的前提，再据此定方案或下结论。
- 适用：方案、根因分析、运维文档承诺，以及回应复审指出的问题。
- 这样做是对的：PR #37 设计前实测推翻了 issue 对 stderr 去向的判断；PR #38 设计前重读代码发现漏盘点两处写入。
- Seen 2×: #26 https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-5726029814 · #39 https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5776234982

### L5
- 规则：合并 base 之后，列出 base 新增的横切约定（写身份、命令行参数、路径写法等），逐一核对它们落到了本 PR 新增的代码路径上；git 没报冲突不等于没有遗漏。
- 适用：PR 合并或 rebase 过 base 之后。
- Seen 1×: #26 https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-6050113829

### L9
- 规则：判定人工是否已拍板，落到具体评论 URL、时间戳和正文核对，不凭「最新评论是自己发的」或「label 已翻回」推定；只有 relabel 时写「未见书面确认，按默认项执行」，查不到勾选编辑者就写「出自谁未验证」。
- 适用：复盘、审计、派工判断人工意图时。
- 这样做是对的：PR #68 只见 relabel 时，PR 正文和复审都明写「未见书面确认，按方案原样执行」，没有把 relabel 当成额外授权。PR #72 的复审同样沿用该写法。
- Seen 1×: #30 https://github.com/GigleAI/cavil-loop/pull/30

### L11
- 规则：测试全绿、复审「实测通过」、PR 合并、生产已实际执行分别声明，不互相代替；「实测过的 / 没跑过的」分栏披露。改到复审/派工自己运行时依赖的脚本或模板时，同时声明「合并部署前仍用旧版」的验证滞后。
- 适用：交人评论、复审结论、复盘里提到验证或上线状态。
- 这样做是对的：PR #64 正文单列「还没验证的」，写明合并部署前仍用旧版指令，并如实说明人工演练证明不了旧规矩挡不住。PR #68 同样单列「还没验证的」，写明部署前记账仍用旧表、新增型号只有夹具覆盖。PR #72 单列「还没验证的」：真机新装、macOS、合并前线上仍是旧代码。
- Seen 1×: #27 https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707826052

### L29
- 规则：把历史引用迁移成计数、且计数会触发自动升级或打回时，先定「什么算一次发生」的判据（被引用、做对、同一原文重复都不算），再用同一判据对全部计数项重扫一遍，迁移表逐行列报告行号与原文，并列出未计入项及原因。
- 适用：迁移或批量重算 Seen、统计类经验时。
- 为什么：PR #62 第 1 轮定了口径，第 2 轮仍被指出把做对的案例算成错误，随后一次扫出 6 处同类误计；程序测试只能查链接与 PR 号，判断不了引用内容的性质。
- Seen 1×: #62 https://github.com/GigleAI/cavil-loop/pull/62#issuecomment-6138466382

### L30
- 规则：新旧布局并存的兼容改造里，选用哪一套按每个已有资源自己的登记或绑定决定，只有全新创建才看整机装了哪套；测试必须含「先有旧资源、再装新组件」的跨轮场景，并对上一版做负对照。
- 适用：改名、迁移过渡期，新旧单元、目录或配置同机共存时。
- 为什么：PR #72 初版仅凭新单元文件存在就让整台机器改读新登记目录，旧预览从列表和注销中消失，同端口可被另一项目重复登记。
- 这样做是对的：PR #72 返工后认主、列表、注销同时查新旧目录，启动读单元绑定的登记，新增跨轮测试的 8 个检查点对上一版全部变红。
- Seen 1×: #72 https://github.com/GigleAI/cavil-loop/pull/72#issuecomment-6283696025
