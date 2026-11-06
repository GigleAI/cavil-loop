# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

`## 硬规则` 段的每一条都已在 3 个以上不同 PR 里出现过：worker 自审和交叉 review 必须逐条核对，适用而没做到的，review 打回。`## 观察中` 段是还没攒够次数的经验，适用时参考。编号永久不变；格式与计次规则见 `scripts/retrospective_lessons.py`。

计次来源：只计复盘报告（`docs/retrospectives/pr-N.md`）写明「这个 PR 里出过这个问题」的；被引用、只是提到不算；当事人按规则自己查出、交付前就改掉的记进「这样做是对的」，不计次。迁移时每一次的报告原文与行号见 `docs/retrospectives/lessons-migration.md`。计次说明问题出现过，不证明每次由同一原因造成。

为满足复盘 8 条上限，本版仅保留硬规则与高价值观察项，其余低频观察项（L6–L8、L10、L12–L28）已移出共享文件，历史见迁移表。

<!-- next-id: 58 -->

## 硬规则

### L1
- 规则：复审对同一根因连续指出第 3 个变体时，停止逐点修补：枚举这段逻辑的全部输入、读、写与入队环节一次收口，配跨轮测试和旧实现负对照；仍收不住，就把「是否换设计」作为选择题交人。
- 适用：返工轮次里，复审指出的问题与前几轮同源时。
- 为什么：数值合法性、失败重试、会话归属、外部配置解析都曾各自返工 5 轮以上，每轮只补上一个变体。
- 这样做是对的：PR #39 改用写入方恒满足的不变式；PR #57 从复刻规则改为直接问 CLI。PR #73 在第 2 个同源变体时就列出全部能碰状态目录的入口一次收口。PR #79 最后一轮把换回流程的输入、读、写、重跑一次理清并配故障注入测试，复审据此通过。PR #110 在复审点名后把路径解析改为以内核真实打开结果为标准答案、按「存在 × 后缀 × 是否经链接」整体对拍，真实写入拒绝场景核对整棵目录。PR #115 在第 1 轮打回后没有只补点名的 3 处，而是把全部写入点列全一次收口，第 2 轮复审直接通过（https://github.com/GigleAI/cavil-loop/pull/115#issuecomment-6576980505）。PR #134 的并发覆盖问题没有再加一次重读，而是去掉「编辑评论」这一步本身，并在每个脚本步骤后跑独立消费者参考实现（https://github.com/GigleAI/cavil-loop/pull/134#issuecomment-6633742704）。
- Seen 8×: #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050467714 · #39 https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774726460 · #44 https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882615439 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6052366557 · #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356247734 · #110 https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6568519638 · #134 https://github.com/GigleAI/cavil-loop/issues/133#issuecomment-6630889716 · #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6622602816

### L3
- 规则：同一条规则有多个实现或调用点（生产者与消费者、jq 与 Python、汇总与明细、多个交付入口）时，复用同一个函数、同一份文字或同一份中间结果；做不到就用同一份输入对拍全部输出，并对每个调用点单独做负对照。
- 适用：计价、计数、去重、判断「是否已有值」，以及要求同时写进多份 prompt 模板时。
- 为什么：新增 token 合计绕过金额去重，补价器与读价方判断不一致；PR #62 的自审表最初只接到返工入口，漏了首次开 PR 和子 issue；PR #72 的路径选择有对拍，但管理端、启动端、systemd 单元对同一端口登记各按不同依据取源，共存状态下漏归属；PR #73 的 worker 会话判断有两份实现，初版只对迁移侧做了负对照；PR #115 的版式测试对成品逐字对拍，但标识规则先去重再比较，通用模板的同文副本盖住了项目附加段缺失，删掉三处要求测试仍全绿；PR #134 的参考消费者只看当前条目正文有无来源标记，发送端却看作者加标记并追关联 issue，对拍只覆盖了选评论、漏了分流；PR #104 的负对照开关有 13 个测试入口，其中三个提示词测试把开关判断放在准备步骤之后，缺少逐入口的行为证明，两种模式全绿都检测不出；PR #150 的「迟到响应是否仍有效」在详情、候选、预览、修改四个入口各用一套判断，修一处漏一处。\\n- 这样做是对的：PR #64 把同一段文字写进三份 worker 指令和 review 附加指令，测试走真实拼装函数对拍成品，并对 7 个写入点逐个做负对照。PR #72 返工后认主、列表、注销共用同一枚举函数，端口锁共用，启动读单元绑定的登记，并对上一版逐检查点做负对照。PR #73 返工后补上轮询侧的单独负对照。PR #78 把第 8 条写进 5 个位置，成品逐字对拍，每个写入点单独做反例，并实际移走附加指令验证通用复审指令仍带这条（https://github.com/GigleAI/cavil-loop/pull/78#issuecomment-6355389753）。PR #77 的中英 × 动静 8 张图由同一张内容表生成，产物逐字节比对，动静说明对拍并有「静态版说法不同」负对照。PR #79 的迁移与注册共用同一搬迁函数和端口锁，并分别禁用两个调用点做负对照（复审复跑 6、17 条变红，https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6355975783）。PR #81 的本机、定时、手动三个发版入口共用同一脚本；「tag 是否有页面」在打 tag 与生成说明两步用同一查询，各自做负对照（https://github.com/GigleAI/cavil-loop/pull/81#issuecomment-6356915134）。PR #83 的冲突检查命令只保留一份原文，写进三份指令，两份 worker 指令的处理规则一致，测试走生产拼装函数对拍成品并对每个写入点单独负对照，复审复跑确认（https://github.com/GigleAI/cavil-loop/pull/83#issuecomment-6357707726）。PR #85 的 ✅ / ❌ 规矩只写在通用复审指令一处，测试对带附加指令与移走附加指令两种成品分别对拍，各做删规矩的负对照，复审复跑确认（https://github.com/GigleAI/cavil-loop/pull/85#issuecomment-6389867281）。PR #87 的 daemon 冲突判定与 worker 交 PR 前的检查命令是两份实现，用同一批 6 个 PR（干净、冲突、判不了）对拍，两边各有独立负对照，复审复跑确认（https://github.com/GigleAI/cavil-loop/pull/87#issuecomment-6392834732）。PR #110 的信任目录规则由部署与派工共用同一函数，两个 driver 共用锁内更新，四个起会话入口共用同一认框出口，并逐入口做负对照（https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6569918937）。PR #115 返工后把附加规则里带编号的那一份单独核对，补齐 27 项负对照，复审用同一份改坏输入对拍新旧测试得到相反结果（https://github.com/GigleAI/cavil-loop/pull/115#issuecomment-6577064775）。PR #134 返工后把分流规则写成协议第一步，用 7 种条目跑真实脚本与参考消费者对拍，并加「只看正文标记」负对照，复审复跑变红（https://github.com/GigleAI/cavil-loop/pull/134#issuecomment-6634672551）。PR #101 的 webhook 发送只有一个共用函数，叫醒与结果通知两个调用点各有负对照；复审指出的 URL 展开问题只在共享函数里修一处，两条真实路径用同一输入各补断言，去掉保护后两边都变红（https://github.com/GigleAI/cavil-loop/pull/101#issuecomment-6544183045）。PR #104 返工后三个入口共用同一 `neg_sandbox`,每个入口各加「建了几个沙盘」的行为断言并对旧顺序做负对照，其余 10 个入口逐个重查开关位置（https://github.com/GigleAI/cavil-loop/pull/104#issuecomment-6551304303）。PR #150 返工后四类异步入口共用 `openSession.ts` 的同一判断，同一组往返输入对拍，详情、预览、修改各有界面负对照（https://github.com/GigleAI/cavil-loop/pull/150#issuecomment-6663357948）。PR #121 的本机、4 路分组、CI 汇总共用同一个 `tests/run.sh`，同一假目录对拍列表、分路、汇总，并分别对分组、排除、汇总做负对照，复审复跑 48/0（https://github.com/GigleAI/cavil-loop/pull/121#issuecomment-6581047608）。
- Seen 11×: #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013473233 · #50 https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049612213 · #55 https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050704401 · #59 https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052446031 · #72 https://github.com/GigleAI/cavil-loop/pull/72#issuecomment-6283696025 · #73 https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284402396 · #115 https://github.com/GigleAI/cavil-loop/pull/115#issuecomment-6576908182 · #134 https://github.com/GigleAI/cavil-loop/pull/134#issuecomment-6634119400 · #104 https://github.com/GigleAI/cavil-loop/pull/104#issuecomment-6551273717 · #150 https://github.com/GigleAI/cavil-loop/pull/150#issuecomment-6662760973 · #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6622602816

### L4
- 规则：测试走真实执行路径和真实形状——真实子进程边界、仓库自带的多行模板与真实日志结构、真实目录布局（如 git worktree）——并断言行为，不断言源码文本。
- 适用：新增或修改测试。
- 为什么：只匹配源码的测试在 bug 存在时仍全绿；单行夹具绕过多行 prompt 缺陷；普通临时目录测不出 worktree 差异。
- 这样做是对的：PR #64 的新测试读仓库真实多行模板，调用派工真正使用的拼装函数，断言合成后的指令内容。PR #73 删掉一条只匹配源码文本的断言，改成在主轮询子进程里探测锁是否已释放（https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284668678）。PR #78 同样读真实多行模板、走生产拼装函数断言成品。PR #77 的检查读真实提交的 SVG、运行真实生成器，并用 16 个负对照和浏览器动画引擎交叉核对。PR #79 返工后改用 `env -i` 干净环境调用真实脚本，不预先导出变量。PR #81 的测试用真实脚本、真实 bare remote 与全新 clone，并从 `release.yml` 读出步骤脚本用 `bash -e` 真跑，断言 tag、退出码和输出（https://github.com/GigleAI/cavil-loop/pull/81#issuecomment-6356915134）。PR #83 的测试读真实多行模板，把检查命令放进真实 git worktree（bare origin + PR 引用 + 假 `gh`）由子进程实跑，断言判定结果与工作区/HEAD 不变，并有两种错误实现的负对照（https://github.com/GigleAI/cavil-loop/pull/83#issuecomment-6357707726）。PR #85 的测试读真实多行模板、走生产拼装函数断言成品，13 个负对照改坏沙盘副本后重新拼装（https://github.com/GigleAI/cavil-loop/pull/85#issuecomment-6389867281）。PR #87 的测试起真实轮询子进程、真实 bare origin 与冲突提交，假 `gh` 记录调用并断言评论/标签行为；返工后把现读 PR 的假数据补齐真实接口的状态字段（https://github.com/GigleAI/cavil-loop/pull/87#issuecomment-6392834732）。PR #110 的测试用真实 git 仓库 / worktree / 子模块 / bare 布局、真实派工与 setup 子进程，屏幕夹具取自真机截屏（https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6569918937）。PR #115 的版式测试读真实多行模板、走生产拼装函数断言成品，复审用独立改坏的副本跑默认回归确认会失败（https://github.com/GigleAI/cavil-loop/pull/115#issuecomment-6577064775）。PR #134 的测试真跑叫醒脚本子进程、真实多行交接评论加真实 footer，用状态式假 GitHub 在请求处理前注入外部编辑，断言评论、标签、退出码与 webhook 次数（https://github.com/GigleAI/cavil-loop/pull/134#issuecomment-6634672551）。PR #143 返工后把配置样例原样复制成项目配置，在干净子进程里 source 公共库断言最终生效值，并用「样例末尾追加覆盖行」「默认值退回」两项负对照验证会变红（https://github.com/GigleAI/cavil-loop/pull/143#issuecomment-6658727879）。PR #101 的测试真跑叫醒脚本与 `agent-poll.sh`、真 curl 打本地真 HTTP 服务、采样 `/proc/*/cmdline`，断言服务端实际收到的请求（https://github.com/GigleAI/cavil-loop/pull/101）。PR #104 新增的到达性检查断言假 GitHub 收到的调用、派工记录和 poll.log 内容而非源码文本，并在真实克隆里做「入口直接退出」演示（https://github.com/GigleAI/cavil-loop/pull/104）。PR #105 的方案复审测试起真实派工脚本子进程读成品，机器人答复位置的对照测试跑真实 `agent-poll.sh` 加状态式假 GitHub，断言派工对象与最终标签（https://github.com/GigleAI/cavil-loop/pull/105#issuecomment-6551564979）。PR #131 的标签颜色测试在隔离 HOME 下真跑安装脚本子进程，假 `gh` 记录每条建标签请求，断言 13 项完整清单，旧主干 13 通过/3 失败、两个负对照变红（https://github.com/GigleAI/cavil-loop/pull/131#issuecomment-6619096475）。PR #163 的新测试每轮真起 `agent-poll.sh` 子进程加有状态假 GitHub 与假 tmux，注入清理失败和写失败，跑满多轮后断言队列、重读次数、日志与标签，并把新测试套到旧提交上得到 71 通过/11 失败（https://github.com/GigleAI/cavil-loop/pull/163#issuecomment-6671908387）。PR #150 的界面测试驱动真实 Electron 窗口，用假 GitHub 暂停具体请求制造交错，断言草稿、按钮与 GitHub 实际收到的评论（https://github.com/GigleAI/cavil-loop/pull/150#issuecomment-6663357948）。PR #121 的入口测试用真子进程调用真实入口与可执行夹具，断言退出码、结果文件、日志与标记文件，并在 GitHub 上真跑绿 → 红 → 绿（https://github.com/GigleAI/cavil-loop/pull/121#issuecomment-6581047608）。
- Seen 6×: #30 https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794 · #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050298312 · #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013196195 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051560673 · #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356118759 · #143 https://github.com/GigleAI/cavil-loop/pull/143#issuecomment-6658681202

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
- 这样做是对的：PR #68 只见 relabel 时，PR 正文和复审都明写「未见书面确认，按方案原样执行」，没有把 relabel 当成额外授权。PR #72、#73、#78、#77、#79、#83 的正文与复审同样写明只见重新打标签、未见书面确认，按方案原样/默认执行。PR #85 的正文与复审同样给出重新打标签的时间戳并写明未见书面确认（https://github.com/GigleAI/cavil-loop/pull/85#issuecomment-6389867281）。PR #87 的正文写明方案勾选 B 的编辑者未验证，并引用 luosky 的 2 天限制评论与改标时间戳（https://github.com/GigleAI/cavil-loop/pull/87#issuecomment-6392834732）。PR #110 的正文与复审给出重新打标签的 UTC 时间戳，写明未见书面确认，「继续修复 / 暂停」两项未勾选也不当作授权（https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6569670655）。PR #134、#101、#104 的正文写明未见书面勾选/确认、按方案原样执行。PR #105 的正文写明 Q1 勾 A 的勾选者没核实、只见重新打标签（https://github.com/GigleAI/cavil-loop/pull/105）。PR #150 的正文写明托管模式下未见书面确认，按子项正文与父方案原样执行（https://github.com/GigleAI/cavil-loop/pull/150）。PR #121 的正文给出重新打标签的 UTC 时间戳，写明未见书面确认，按方案原样执行，复审也不凭勾选变化推断授权（https://github.com/GigleAI/cavil-loop/pull/121）。PR #132 的正文和复审同样写明只见翻标签、未见书面确认，勾选人未验证（https://github.com/GigleAI/cavil-loop/pull/132）。
- Seen 1×: #30 https://github.com/GigleAI/cavil-loop/pull/30

### L11
- 规则：测试全绿、复审「实测通过」、PR 合并、生产已实际执行分别声明，不互相代替；「实测过的 / 没跑过的」分栏披露。改到复审/派工自己运行时依赖的脚本或模板时，同时声明「合并部署前仍用旧版」的验证滞后。
- 适用：交人评论、复审结论、复盘里提到验证或上线状态。
- 这样做是对的：PR #64、#68、#72、#73、#78、#77、#79、#81 均单列「还没验证的」（旧版指令仍在用、真机/macOS/真实 systemd/真实令牌未跑等），复审区分 worker 自报与独立复跑。PR #83、#85 单列：部署前仍用旧指令、测试证明不了 agent 照做（https://github.com/GigleAI/cavil-loop/pull/85）。PR #87 单列：部署前 daemon 仍是旧版、真实交回链路与双机竞态未跑（https://github.com/GigleAI/cavil-loop/pull/87#issuecomment-6392752532）。PR #110 单列：真实 daemon 端到端、macOS、窄终端未验（https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6569918937）。PR #115、#134、#143 单列部署前仍用旧指令/旧脚本/旧默认值，复审区分独立复跑与自报（https://github.com/GigleAI/cavil-loop/pull/143#issuecomment-6658784789）。PR #101 复审把自报的 1124 更正为独立复跑的 1125（https://github.com/GigleAI/cavil-loop/pull/101#issuecomment-6544324626）。PR #104 复审写明完整开关模式没有独立跑完，不冒充已验证（https://github.com/GigleAI/cavil-loop/pull/104#issuecomment-6551332319）。PR #105 区分测试通过、复审通过、合并、上线（https://github.com/GigleAI/cavil-loop/pull/105#issuecomment-6551703032）。PR #131 单列未在真实新仓库跑安装脚本（https://github.com/GigleAI/cavil-loop/pull/131#issuecomment-6619096475）。PR #163 单列真实 GitHub 关闭原因与标签写入未验证、部署前仍是旧逻辑（https://github.com/GigleAI/cavil-loop/pull/163）。PR #150 单列「还没验证的」：真 Mac 界面、真实 GitHub 写操作均只对假 GitHub 跑过（https://github.com/GigleAI/cavil-loop/pull/150）。PR #121 单列「还没验证的」：手动负对照、fork PR 未在 GitHub 上跑，复审把自报数字与独立复跑分开（https://github.com/GigleAI/cavil-loop/pull/121#issuecomment-6581047608）。PR #132 单列「还没验证的」：真实 GitHub 接手未跑、部署前线上仍是旧版，复审把自报的全量负对照与独立抽跑分开（https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6628757002）。
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
- 为什么：PR #78 正文称旧 main 上「另有 1 个反例没被拦下」，复审复跑为 4 个，12 通过 / 5 失败；结论不变，但数字不准。PR #132 正文写负对照 58 份、已跑 12 份，复审实测当前为 55 项。
- 这样做是对的：PR #83 正文的 36/0 与旧主干 8/28 经复审复跑完全一致（https://github.com/GigleAI/cavil-loop/pull/83#issuecomment-6357707726）。PR #85 正文的 14/0 与旧主干 3/11 同样经复审复跑一致，并说明其余失败是旧版没有规矩可改坏，不是 11 个生产缺陷（https://github.com/GigleAI/cavil-loop/pull/85#issuecomment-6389867281）。PR #87 正文的 59/0 与旧主干 35/22，复审复跑一致，并说明通过的 35 条都是「不该写的没写」（https://github.com/GigleAI/cavil-loop/pull/87#issuecomment-6392752532）。PR #131 正文的旧主干 13 通过/3 失败经复审在临时 clone 复跑一致（https://github.com/GigleAI/cavil-loop/pull/131#issuecomment-6619096475）。PR #163 正文的 68/0 与 10 项负对照变红数经复审复跑一致（https://github.com/GigleAI/cavil-loop/pull/163#issuecomment-6671552367）。PR #121 正文的入口测试 41/0 与 48/0 经复审复跑一致，未复跑的全量负对照明确标为自报（https://github.com/GigleAI/cavil-loop/pull/121#issuecomment-6581047608）。
- Seen 2×: #78 https://github.com/GigleAI/cavil-loop/pull/78#issuecomment-6355389753 · #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6619558657

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
- 这样做是对的：PR #79 返工后列出全部 4 处读状态点，各自做反例并配对旧提交的负对照。PR #81 返工后，查 Release 列表失败时打 tag 与生成说明两步都直接失败，不猜「有」或「没有」，并对两处各做负对照（https://github.com/GigleAI/cavil-loop/pull/81#issuecomment-6356871289）。PR #83 的冲突检查在目标分支/PR 提交取不到、`gh` 无回显时判「检查失败」而不是「无冲突」，复审检查失败不得判通过。PR #87 的 daemon 判不了（拉取失败、git 报错）时不写任何东西、下轮再判，同一对提交最多判 10 次。
- Seen 1×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6355975783

### L37
- 规则：替换关键登记或配置文件时，先备份再在同目录原子覆盖，新内容就位前不制造「两处都没有」的空位；测试注入替换中途失败，断言原登记仍在且重跑能完成。
- 适用：恢复、换回、迁移等会改写登记文件的流程。
- 为什么：PR #79 的换回脚本先 mv 走现登记再 mv 入新文件，第二步失败后登记消失且重跑被拒。
- Seen 1×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356247734

### L38
- 规则：写给人照做的恢复或运维步骤，要在干净环境按文档字面逐条执行验证，覆盖进入、操作、退出、检查到回退的完整生命周期，且不由夹具额外导出变量；文档承诺的回退条件必须在回退时点仍成立。
- 适用：文档里新增人工处理步骤或恢复命令时。
- 为什么：PR #79 初版文档的端口变量传不进持锁子 shell，且承诺的「旧入口仍保留」在最后一个冲突处理后已不成立；另有一条文档办法因归属保护实际执行不了。PR #105 的对接文档约定段要求机器人把 PR 验收答复贴到来源 issue，与流程表要求在 PR 上回复冲突，按字面操作会重新派发 issue、PR 仍挂等待标签，既有 1126 条测试都没覆盖这条操作。
- Seen 2×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356118759 · #105 https://github.com/GigleAI/cavil-loop/pull/105#issuecomment-6551408884

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

### L41
- 规则：daemon 在判定与写 GitHub（评论、翻标签）之间必须重读目标，并把判定所依据的全部身份与状态（是否打开、是否已合并、目标分支、最新提交、来源属性、标签保护）逐项比对；任一项不符或缺字段，本轮不写、不记已处理。
- 适用：先判定、后对外写入，且两步之间有时间间隔的自动化。
- 为什么：PR #87 首版写前重读只核对提交与标签，改投分支或已合并关闭的 PR 仍被发评论并派工；测试夹具缺少真实接口的状态字段，缺字段被当成有效。PR #132 的阈值交人路径写前只保留标签，PR 已关闭仍加标签、留言并记完成。
- 这样做是对的：PR #87 返工时没有只补点名的两条，而是一次列全写前依赖字段，补跨快照测试和去掉核对的负对照。PR #132 最终让交人待办在动手前用同一个接手判断现读重判。
- Seen 2×: #87 https://github.com/GigleAI/cavil-loop/pull/87#issuecomment-6392752532 · #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6621606711

### L42
- 规则：对会杀会话、转人工等有破坏性后果的自动处置，识别条件必须基于界面结构或状态（标题、选项行、末行底栏等同时满足），不能只凭一个短语；并配「真实弹框应拦下」和「正常输出引用同样文案应放行」的对拍，用宽松识别作负对照。
- 适用：通过屏幕内容、日志文本判断子进程状态并据此处置时。
- 为什么：PR #110 首版把整屏压成一行，只要出现「Quick safety check」就杀会话并转人工，而修这个功能的任务本身会天天讨论这些词。
- 这样做是对的：返工后用两个 CLI 的真机截屏定结构，并有对话引用整段确认框仍放行的真实派工场景。
- Seen 1×: #110 https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6567995152

### L43
- 规则：为模仿外部系统行为（内核路径解析、CLI 判定）的实现写测试时，标准答案取自该系统的真实行为（真实打开、真实 CLI），不用另一个模仿实现或字符串化简结果作参照。
- 适用：路径解析、外部规则复刻的对拍测试。
- 为什么：PR #110 的软链接解析用非严格 `os.path.realpath` 作参照，放过了「普通文件/..」这类内核会拒绝的路径，两个实现一起漏。
- 这样做是对的：返工后同一布局建两份，一份交给被测函数，一份让内核真实以写方式打开，逐条对上。
- Seen 1×: #110 https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6568519638

### L44
- 规则：测试自身的准备或夹具步骤失败（例如负对照找不到要改的原文）必须传到父进程并让整套测试非零退出，不能被子 shell 或命令替换吞掉；加一个故意准备失败的自检证明整套会红。
- 适用：含变异、负对照、动态夹具的测试脚本。
- 为什么：PR #110 一项负对照在子 shell 里准备失败，失败计数传不回父进程，整套仍报「通过 146，失败 0」，「18 项」只是 gate 计数。
- 这样做是对的：PR #104 保留 `REQUESTER_BOT_TEST_BAD_MUT=1` 自检：开关打开时 58 项跑完，唯一失败是故意制造的准备失败；只设自检不开开关则退出码 2 报错。pending-human-conflict、comment-footer 把源码原文改一个空格，开关模式也会变红（https://github.com/GigleAI/cavil-loop/pull/104）。PR #94 在交付前自查发现 comment-footer 测试里 12 条模板检查经管道送进计数、失败进不了退出码（打印通过 99 少于实际 ✅ 111），改为进程替换后两者一致（https://github.com/GigleAI/cavil-loop/pull/94）。
- Seen 1×: #110 https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6568519638

### L45
- 规则：写文件前的前置解析（真实路径、依赖工具）失败时，必须拒绝写入并向调用方返回失败，不得回退到未解析的原输入继续做破坏性写入，也不得打印成功日志。
- 适用：对软链接、外部配置做原子替换等写入的函数。
- 为什么：PR #110 首版用 python 解析软链接，失败后静默沿用原路径做原子替换，拆掉了配置软链接，目标文件没收到记录，却返回成功。
- Seen 1×: #110 https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6567995152

### L46
- 规则：多个项目或脚本共写同一份用户级配置文件时，不要把「同目录临时文件 + 原子替换」当并发保护；互斥按配置文件真实路径划分，持锁后才读、判断、写，并配受控交错测试和去锁负对照；对不认锁的外部写入者，披露保证不了的边界。
- 适用：往多项目共享的用户配置（agent 配置、登记文件）里补写记录时。
- 为什么：PR #110 方案阶段的写法在两个项目同时补记录时，后替换的把先替换的抹掉，两个调用都返回成功。
- Seen 1×: #110 https://github.com/GigleAI/cavil-loop/issues/108#issuecomment-6567462670

### L47
- 规则：测试里「改动前的旧版本」基准要取固定提交或「首次引入该文件的提交」的上一版，不取随主干移动的引用；每次模板或脚本合并后，复跑所有用到主干基准的对拍。
- 适用：新旧实现对拍、问题重现类测试。
- 为什么：PR #115 发现设计复审对拍把主干的模板当旧基准，任何只改模板文字的 PR 都红 10 条；单元链接修复测试的旧部署器取主干，#111 合并后主干已是修好的版本，「问题重现」恒红。
- 这样做是对的：PR #134 发现 #106 遗留的 6 条负对照取 merge-base 而不变红，把基准固定到 #106 合并前的提交，6 条变红（https://github.com/GigleAI/cavil-loop/pull/134#issuecomment-6633742704）。PR #105 在交付前自查出机器人测试拿 merge-base 模板文字对拍会让后续改模板的 PR 变红，改成用旧拼装代码拼本版模板（https://github.com/GigleAI/cavil-loop/pull/105）。
- Seen 1×: #115 https://github.com/GigleAI/cavil-loop/pull/115

### L48
- 规则：把运维者配置的值（地址、请求头等）交给 curl、shell 等带展开或转义语义的工具时，测试里必须有一条含该工具元字符的输入（如 `[1-2]`、`{a,b}`），真跑并断言对端实际收到的请求，再做关掉对应开关的负对照。
- 适用：向外部地址发请求、拼装命令行或配置文本的脚本。
- 为什么：PR #101 初版把地址经标准输入传给 curl，只解决了不进命令行；curl 默认仍展开 `[1-2]`，一次叫醒发出多次请求，成功被误报为连接失败，1118 条测试全绿仍没发现。
- 这样做是对的：返工后在共享函数加 `--globoff`，叫醒与结果通知两条真实路径用同一含元字符的地址各补断言，去掉保护后两边都变红。
- Seen 1×: #101 https://github.com/GigleAI/cavil-loop/pull/101#issuecomment-6544006826

### L49
- 规则：给慢速或重复性检查（如负对照）加「默认跳过」开关时，把开关判断放在第一个复制、改文件、建沙盘等准备步骤之前，并在关闭模式下用副作用计数（建了几个沙盘）断言准备确实没执行，不只断言汇总文字。
- 适用：新增或修改带开关、可跳过的测试入口，尤其是多个测试各自接入同一开关时。
- 为什么：PR #104 初版把 `mutation_gate` 放在 `expect_red()` 内，三个提示词测试在默认模式仍建了 13、16、12 个沙盘并改模板，汇总却显示「跳过」；两种模式全绿都检测不出，默认回归仍依赖仅供负对照使用的源码原文。
- 这样做是对的：PR #104 返工后统一用 `neg_sandbox` 先过开关再建沙盘，默认模式断言沙盘数为 0、开关打开时大于 0，并把顺序改回去验证三个测试全变红。PR #105 解冲突后把新增负对照每项先在主 shell 调 `mutation_gate`，默认与 `MUTATION=1` 两种模式分别实跑（https://github.com/GigleAI/cavil-loop/pull/105#issuecomment-6554555631）。
- Seen 1×: #104 https://github.com/GigleAI/cavil-loop/pull/104#issuecomment-6551273717

### L50
- 规则：为「完整清单」类断言确定预期集合时，从被测代码枚举全部项（含所有可选开关打开后的结果），不以参考数据源（如线上现有列表）的数量代替；预期清单逐项断言名字、值和总数。
- 适用：方案或测试要覆盖一张由代码生成的表（标签、配置项、模板写入点）时。
- 为什么：PR #131 方案首版按本仓库已有的 11 个标签设计测试，安装脚本全开关实际生成 13 个，被方案复审指出。
- 这样做是对的：修订版列出 13 项完整预期表并核对源码定义，实现后旧主干上新测试 13 通过/3 失败。
- Seen 1×: #131 https://github.com/GigleAI/cavil-loop/issues/130#issuecomment-6618821176

### L51
- 规则：新增或改动较慢的测试文件后，交付前复跑测试入口自身的分组检查（`bash tests/run.test.sh`），并按实测更新过时的参考时间，不放宽阈值。
- 适用：新增测试文件，或某个测试文件明显变慢的 PR。
- 为什么：PR #163 新增测试使 CI 分片总量变化，requester-bot 的参考时间已过时，分组检查在 CI 变红，功能测试却全绿，被 daemon 打回一次。
- Seen 1×: #163 https://github.com/GigleAI/cavil-loop/pull/163#issuecomment-6672107653

### L52
- 规则：给「最多重试 N 轮」的队列设计耗尽处理时，耗尽状态要独立于上游去重状态持久保留（记为已结束），直到上游条件真正解除才删；测试叠加「上游状态持续不推进」跑过上限后至少两轮，断言不再重读或写。
- 适用：带重试上限、且入队条件依赖另一个可能持续失败的状态（如清理成功记录）的队列。
- 为什么：PR #163 初版耗尽即删记录，而本机清理持续失败使该 issue 每轮重新入队，计数归零，7 轮内「放弃」两次，上限形同虚设；既有测试把两种失败分开跑，漏了交叉组合。
- 这样做是对的：返工后改为记「已结束」、入队保留已有值、清理成功才删，并对四个入口各做负对照，旧提交上新断言 71 通过/11 失败。
- Seen 1×: #163 https://github.com/GigleAI/cavil-loop/pull/163#issuecomment-6671552367

### L53
- 规则：约定「只和某些域名通信」的客户端，对详情、预览等加载外部内容的入口，要在真实窗口里记录实际发出的网络请求，断言允许的域名发出、禁止的域名零请求；不能只断言内容安全策略字符串。
- 适用：桌面或网页客户端渲染 GitHub 返回的 HTML、图片、媒体时。
- 为什么：PR #150 初版放开任意 HTTPS 图片，复审用真实 Electron 观察到 camo 域名请求，现有测试只检查策略字符串而全绿。
- 这样做是对的：PR #150 返工后页面策略加主进程请求过滤双层限制，并用请求记录做正反断言（https://github.com/GigleAI/cavil-loop/pull/150#issuecomment-6662760973）。
- Seen 1×: #150 https://github.com/GigleAI/cavil-loop/pull/150#issuecomment-6662127445

### L54
- 规则：读取带嵌套列表的分页接口（如评审下的逐行评论）时，外层和每个内层列表都要翻页读完再合并排序；任何一页失败整次报错，不显示成完整内容；测试用超过单页上限的数据和后续页失败各补一条。
- 适用：读取评论、评审、文件列表等 GraphQL 或 REST 分页数据时。
- 为什么：PR #150 初版每个评审只取前 100 条逐行评论，101 条时少一条且页面只提示「在网页上看」。
- Seen 1×: #150 https://github.com/GigleAI/cavil-loop/pull/150#issuecomment-6662127445

### L55
- 规则：新增 CI 或把测试搬到干净机器前，用最小环境模拟预检：固定时区、不带全局 git 配置，并在测试里显式指定假仓库的分支名、清除外层 CI 变量；首次真实 CI 的失败逐个查明是测试依赖开发机还是产品问题。
- 适用：把本机手动跑的测试首次接入 CI，或新增会建临时 git 仓库、读时间的测试时。
- 为什么：PR #121 首次 GitHub 运行 5 个测试失败：假仓库跟随本机默认分支、夹具时区跟随本机、外层 CI 变量漏进被测运行。补跑模拟命令后同类问题一次收干净。
- 这样做是对的：PR #121 逐处单列修改，未改断言，只改环境准备，并补了本机模拟 GitHub 机器的命令。
- Seen 1×: #121 https://github.com/GigleAI/cavil-loop/pull/121

### L56
- 规则：需要比较多个来源的授权或证据时，先保留全部有效候选，逐条应用最终条件（先后、身份），再取结论；不要先压成单个"最新"候选再比较。
- 适用：授权、叫停等需要跨来源比较时间或顺序的判断。
- 为什么：PR #132 先把 issue 和 PR 两处授权压成一条，同一秒时保留 issue 那条，PR 内明确在后的授权被丢掉，托管误停。
- 这样做是对的：PR #132 修复后保留全部成立的授权，逐条与最后一次 `pending/human` 比较，并按来源、同秒或不同秒、PR 内先后列成 6 行对拍。
- Seen 1×: #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6626707181

### L57
- 规则：组合表或对拍测试里的预期值，按规则推导，不按现行实现的输出改写；改预期时写明依据。
- 适用：为多入口、多输入组合写表驱动对拍测试时。
- 为什么：PR #132 的组合表把"接手且 PR 没标签"一行的预期强改为不接手，等于把错误行为固定成了预期，默认回归全绿仍放过了缺陷。
- Seen 1×: #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6619558657
