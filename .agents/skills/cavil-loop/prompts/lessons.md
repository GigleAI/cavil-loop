# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

`## 硬规则` 段的每一条都已在 3 个以上不同 PR 里出现过：worker 自审和交叉 review 必须逐条核对，适用而没做到的，review 打回。`## 观察中` 段是还没攒够次数的经验，适用时参考。编号永久不变；格式与计次规则见 `scripts/retrospective_lessons.py`。

计次来源：只计复盘报告（`docs/retrospectives/pr-N.md`）写明「这个 PR 里出过这个问题」的；被引用、只是提到不算；当事人按规则自己查出、交付前就改掉的记进「这样做是对的」，不计次。迁移时每一次的报告原文与行号见 `docs/retrospectives/lessons-migration.md`。计次说明问题出现过，不证明每次由同一原因造成。

为满足复盘 8 条上限，本版仅保留硬规则与高价值观察项，其余低频观察项（L6–L8、L10、L12–L28）已移出共享文件，历史见迁移表。

<!-- next-id: 41 -->

## 硬规则

### L1
- 规则：复审对同一根因连续指出第 3 个变体时，停止逐点修补：枚举这段逻辑的全部输入、读、写与入队环节一次收口，配跨轮测试和旧实现负对照；仍收不住，就把「是否换设计」作为选择题交人。
- 适用：返工轮次里，复审指出的问题与前几轮同源时。
- 为什么：数值合法性、失败重试、会话归属、外部配置解析都曾各自返工 5 轮以上，每轮只补上一个变体。
- 这样做是对的：PR #39 改用写入方恒满足的不变式；PR #57 从复刻规则改为直接问 CLI。PR #73 在第 2 个同源变体时就列出全部能碰状态目录的入口一次收口。PR #79 最后一轮把换回流程的输入、读、写、重跑一次理清并配故障注入测试，复审据此通过。
- Seen 5×: #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050467714 · #39 https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774726460 · #44 https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882615439 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6052366557 · #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356247734

### L3
- 规则：同一条规则有多个实现或调用点（生产者与消费者、jq 与 Python、汇总与明细、多个交付入口）时，复用同一个函数、同一份文字或同一份中间结果；做不到就用同一份输入对拍全部输出，并对每个调用点单独做负对照。
- 适用：计价、计数、去重、判断「是否已有值」，以及要求同时写进多份 prompt 模板时。
- 为什么：新增 token 合计绕过金额去重，补价器与读价方判断不一致；PR #62 的自审表最初只接到返工入口，漏了首次开 PR 和子 issue；PR #72 的路径选择有对拍，但管理端、启动端、systemd 单元对同一端口登记各按不同依据取源，共存状态下漏归属；PR #73 的 worker 会话判断有两份实现，初版只对迁移侧做了负对照。
- 这样做是对的：PR #64 把同一段文字写进三份 worker 指令和 review 附加指令，测试走真实拼装函数对拍成品，并对 7 个写入点逐个做负对照。PR #72 返工后认主、列表、注销共用同一枚举函数，端口锁共用，启动读单元绑定的登记，并对上一版逐检查点做负对照。PR #73 返工后补上轮询侧的单独负对照。PR #78 把第 8 条写进 5 个位置，成品逐字对拍，每个写入点单独做反例，并实际移走附加指令验证通用复审指令仍带这条（https://github.com/GigleAI/cavil-loop/pull/78#issuecomment-6355389753）。PR #77 的中英 × 动静 8 张图由同一张内容表生成，产物逐字节比对，动静说明对拍并有「静态版说法不同」负对照。PR #79 的迁移与注册共用同一搬迁函数和端口锁，并分别禁用两个调用点做负对照（复审复跑 6、17 条变红，https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6355975783）。PR #81 的本机、定时、手动三个发版入口共用同一脚本；「tag 是否有页面」在打 tag 与生成说明两步用同一查询，各自做负对照（https://github.com/GigleAI/cavil-loop/pull/81#issuecomment-6356915134）。PR #83 的冲突检查命令只保留一份原文，写进三份指令，两份 worker 指令的处理规则一致，测试走生产拼装函数对拍成品并对每个写入点单独负对照，复审复跑确认（https://github.com/GigleAI/cavil-loop/pull/83#issuecomment-6357707726）。PR #85 的 ✅ / ❌ 规矩只写在通用复审指令一处，测试对带附加指令与移走附加指令两种成品分别对拍，各做删规矩的负对照，复审复跑确认（https://github.com/GigleAI/cavil-loop/pull/85#issuecomment-6389867281）。
- Seen 6×: #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013473233 · #50 https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049612213 · #55 https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050704401 · #59 https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052446031 · #72 https://github.com/GigleAI/cavil-loop/pull/72#issuecomment-6283696025 · #73 https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284402396

### L4
- 规则：测试走真实执行路径和真实形状——真实子进程边界、仓库自带的多行模板与真实日志结构、真实目录布局（如 git worktree）——并断言行为，不断言源码文本。
- 适用：新增或修改测试。
- 为什么：只匹配源码的测试在 bug 存在时仍全绿；单行夹具绕过多行 prompt 缺陷；普通临时目录测不出 worktree 差异。
- 这样做是对的：PR #64 的新测试读仓库真实多行模板，调用派工真正使用的拼装函数，断言合成后的指令内容。PR #73 删掉一条只匹配源码文本的断言，改成在主轮询子进程里探测锁是否已释放（https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284668678）。PR #78 同样读真实多行模板、走生产拼装函数断言成品。PR #77 的检查读真实提交的 SVG、运行真实生成器，并用 16 个负对照和浏览器动画引擎交叉核对。PR #79 返工后改用 `env -i` 干净环境调用真实脚本，不预先导出变量。PR #81 的测试用真实脚本、真实 bare remote 与全新 clone，并从 `release.yml` 读出步骤脚本用 `bash -e` 真跑，断言 tag、退出码和输出（https://github.com/GigleAI/cavil-loop/pull/81#issuecomment-6356915134）。PR #83 的测试读真实多行模板，把检查命令放进真实 git worktree（bare origin + PR 引用 + 假 `gh`）由子进程实跑，断言判定结果与工作区/HEAD 不变，并有两种错误实现的负对照（https://github.com/GigleAI/cavil-loop/pull/83#issuecomment-6357707726）。PR #85 的测试读真实多行模板、走生产拼装函数断言成品，13 个负对照改坏沙盘副本后重新拼装（https://github.com/GigleAI/cavil-loop/pull/85#issuecomment-6389867281）。
- Seen 5×: #30 https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794 · #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050298312 · #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013196195 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051560673 · #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356118759

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
- 这样做是对的：PR #68 只见 relabel 时，PR 正文和复审都明写「未见书面确认，按方案原样执行」，没有把 relabel 当成额外授权。PR #72 的复审同样沿用该写法。PR #73 的 issue 与复审同样写明「未见书面勾选，按方案默认安排」。PR #78 的 PR 正文与复审也写明只有重新打标签、未见书面确认。PR #77 的 worker 与复审同样写明只见重新打标签、按方案原样执行。PR #79 的正文与复审同样写明未见书面确认，第3轮的交付选择未勾选时也按默认 A。PR #83 的正文与复审同样写明只见重新打标签、未见书面确认，按方案原样执行。PR #85 的正文与复审同样给出重新打标签的时间戳并写明未见书面确认（https://github.com/GigleAI/cavil-loop/pull/85#issuecomment-6389867281）。
- Seen 1×: #30 https://github.com/GigleAI/cavil-loop/pull/30

### L11
- 规则：测试全绿、复审「实测通过」、PR 合并、生产已实际执行分别声明，不互相代替；「实测过的 / 没跑过的」分栏披露。改到复审/派工自己运行时依赖的脚本或模板时，同时声明「合并部署前仍用旧版」的验证滞后。
- 适用：交人评论、复审结论、复盘里提到验证或上线状态。
- 这样做是对的：PR #64 正文单列「还没验证的」，写明合并部署前仍用旧版指令，并如实说明人工演练证明不了旧规矩挡不住。PR #68 同样单列「还没验证的」，写明部署前记账仍用旧表、新增型号只有夹具覆盖。PR #72 单列「还没验证的」：真机新装、macOS、合并前线上仍是旧代码。PR #73 同样列出真实 systemd、macOS 真机、合并后两台机器迁移均未验证。PR #78 单列「还没验证的」：部署前仍用旧指令、测试证明不了 agent 照做。PR #77 单列 Safari、手机 App 未验证，复审也不把 worker 的网页播放自述当作独立实测。PR #79 单列「没跑过的」：真实 systemd、14 个旧预览、socket 激活测试，复审明确区分 worker 自报与独立复核。PR #81 单列「还没验证的」：真实 Actions 令牌、定时与 checkout 均未跑过，并给出合并后验收与回退步骤。PR #83 单列「还没验证的」：部署前仍用旧指令、测试证明不了 agent 照做、git 版本要求未在另一台机器核对（https://github.com/GigleAI/cavil-loop/pull/83）。PR #85 单列「还没验证的」：部署前复审仍用旧指令、测试证明不了复审 agent 照做，复审也写明未验证部署后行为（https://github.com/GigleAI/cavil-loop/pull/85）。
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

### L31
- 规则：「先检查、再动作」的条件（空闲、无 worker、可开始轮询）必须在持有对应锁之后检查，互斥范围覆盖从检查到动作完成的整段；配「检查后、拿锁前有人插入」的受控交错测试，并对旧实现做负对照。
- 适用：迁移、搬目录、切换调度等会被并发轮询打断的操作。
- 为什么：PR #73 初版在拿锁之前枚举会话判断空闲，判断过期后仍搬走刚派出 worker 的项目；第 2 轮又发现只看一次进度文件，并发轮询仍能绕过暂停。
- 这样做是对的：PR #73 返工后先拿项目轮询锁再判断空闲，并让迁移锁的共享侧覆盖从看进度文件到主轮询取得项目锁的整段，用真实子进程交错测试。
- Seen 1×: #73 https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284402396

### L32
- 规则：交接调度任务时先启用并启动新任务，确认成功后再停旧任务；故障注入测试覆盖新任务启用失败、启动失败、旧任务停用失败，验证无需人工也有下一轮。
- 适用：定时任务、后台服务的改名或迁移交接。
- 为什么：PR #73 初版先停旧再启新，新任务启动失败后旧新任务都不在运行，没有下一轮能恢复迁移。
- Seen 1×: #73 https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284402396

### L33
- 规则：可重复运行的入口（安装、迁移后重装）只在没有已有状态时才初始化，已有状态必须原样保留；测试逐字节核对迁移前后及重复运行后的状态。
- 适用：安装脚本、种子/初始化步骤与迁移流程相邻时。
- 为什么：PR #73 初版在迁移成功后，安装脚本又无条件初始化，把已读评论记录冲成空表；该初始化问题在已装项目重跑安装时本就存在。
- Seen 1×: #73 https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284530867

### L34
- 规则：PR 正文里的实测数字（尤其是新测试套到旧版本的通过/失败/未拦下个数）写明命令与口径，交付前复跑核对；独立复审复跑得出不同数字时，以复跑为准并在正文更正。
- 适用：PR 正文或交人评论引用对拍、负对照的计数时。
- 为什么：PR #78 正文称旧 main 上「另有 1 个反例没被拦下」，复审复跑为 4 个，12 通过 / 5 失败；结论不变，但数字不准。
- 这样做是对的：PR #83 正文的 36/0 与旧主干 8/28 经复审复跑完全一致（https://github.com/GigleAI/cavil-loop/pull/83#issuecomment-6357707726）。PR #85 正文的 14/0 与旧主干 3/11 同样经复审复跑一致，并说明其余失败是旧版没有规矩可改坏，不是 11 个生产缺陷（https://github.com/GigleAI/cavil-loop/pull/85#issuecomment-6389867281）。
- Seen 1×: #78 https://github.com/GigleAI/cavil-loop/pull/78#issuecomment-6355389753

### L35
- 规则：检查「任意时刻最多一段可见」这类时序属性时，把全部动画的切换时间合并、按恒定小区间逐段判定，不靠固定间隔采样；并配一个短于旧采样间隔的负对照，证明旧检查放过、新检查拦下。
- 适用：为动画、定时切换等离散时序行为写自动检查时。
- 为什么：PR #77 的检查器每 0.05 秒采样一次，复审把第二段说明额外闪现 0.01 秒后整套测试仍全绿。
- 这样做是对的：PR #77 返工后改为按全部切换点切段，新增 2 个短暂错误负对照，并用上一版检查跑同一套测试证明能区分新旧。
- Seen 1×: #77 https://github.com/GigleAI/cavil-loop/pull/77#issuecomment-6355385064

### L36
- 规则：读取外部服务状态时区分「明确的否」与「查不到」：只认已知状态词，空输出或连接失败一律算未知，未知时不记录原状、不确认停止、不收尾，保留旧状态留待下一轮。
- 适用：脚本依赖 systemctl 等状态查询来决定迁移、停止或删除时。
- 为什么：PR #79 初版把服务管理器连不上当成「原本不开」和「已停」，收走旧登记并删除旧入口。
- 这样做是对的：PR #79 返工后列出全部 4 处读状态点，各自做反例并配对旧提交的负对照。PR #81 返工后，查 Release 列表失败时打 tag 与生成说明两步都直接失败，不猜「有」或「没有」，并对两处各做负对照（https://github.com/GigleAI/cavil-loop/pull/81#issuecomment-6356871289）。PR #83 的冲突检查在目标分支/PR 提交取不到、`gh` 无回显时判「检查失败」而不是「无冲突」，复审检查失败不得判通过。
- Seen 1×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6355975783

### L37
- 规则：替换关键登记或配置文件时，先备份再在同目录原子覆盖，新内容就位前不制造「两处都没有」的空位；测试注入替换中途失败，断言原登记仍在且重跑能完成。
- 适用：恢复、换回、迁移等会改写登记文件的流程。
- 为什么：PR #79 的换回脚本先 mv 走现登记再 mv 入新文件，第二步失败后登记消失且重跑被拒。
- Seen 1×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356247734

### L38
- 规则：写给人照做的恢复或运维步骤，要在干净环境按文档字面逐条执行验证，覆盖进入、操作、退出、检查到回退的完整生命周期，且不由夹具额外导出变量；文档承诺的回退条件必须在回退时点仍成立。
- 适用：文档里新增人工处理步骤或恢复命令时。
- 为什么：PR #79 初版文档的端口变量传不进持锁子 shell，且承诺的「旧入口仍保留」在最后一个冲突处理后已不成立；另有一条文档办法因归属保护实际执行不了。
- Seen 1×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356118759

### L39
- 规则：用备份恢复前，先在持锁后、任何停止或写入之前核对备份记录的端口、内容里的端口，以及当前登记仍是当初留下的那一份；对不上就拒绝并保持所有状态不变，测试逐字节核对。
- 适用：提供备份换回、回滚类命令时。
- 为什么：PR #79 的换回命令接受另一端口的备份，覆盖了无关项目的登记并报告成功。
- Seen 1×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356247734

### L40
- 规则：多步外部副作用流程（如先推 tag 再建页面）判断「是否已完成」时，以最终产物为准，不以中间产物代替；测试必须含「前一步成功、后一步失败、全新环境重跑」的场景，并对旧实现做负对照。
- 适用：定时或手动可重复触发的发布、迁移、同步类自动化。
- 为什么：PR #81 首版把「HEAD 已有 tag」当作「已发布」，推 tag 后建页面失败时，重跑显示「本轮无新提交」，页面不会补建，且后续说明的起点会漏掉这个 tag；首版 50 条测试全绿，靠复审故障注入才发现。
- 这样做是对的：PR #81 返工后，以仓库 Release 列表判断是否已发布，只有 tag 没页面时沿用该 tag 补建，并配故障注入和多组负对照。
- Seen 1×: #81 https://github.com/GigleAI/cavil-loop/pull/81#issuecomment-6356803540
