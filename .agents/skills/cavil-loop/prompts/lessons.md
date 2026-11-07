# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

`## 硬规则` 段的每一条都已在 3 个以上不同 PR 里出现过：worker 自审和交叉 review 必须逐条核对，适用而没做到的，review 打回。`## 观察中` 段是还没攒够次数的经验，适用时参考。编号永久不变；格式与计次规则见 `scripts/retrospective_lessons.py`。

计次来源：只计复盘报告（`docs/retrospectives/pr-N.md`）写明「这个 PR 里出过这个问题」的；被引用、只是提到不算；当事人按规则自己查出、交付前就改掉的记进「这样做是对的」，不计次。迁移时每一次的报告原文与行号见 `docs/retrospectives/lessons-migration.md`。计次说明问题出现过，不证明每次由同一原因造成。

为满足复盘 8 条上限，本版仅保留硬规则与高价值观察项，其余低频观察项（L6–L8、L10、L12–L28）已移出共享文件，历史见迁移表。

<!-- next-id: 68 -->

## 硬规则

### L1
- 规则：复审对同一根因连续指出第 3 个变体时，停止逐点修补：枚举这段逻辑的全部输入、读、写与入队环节一次收口，配跨轮测试和旧实现负对照；仍收不住，就把「是否换设计」作为选择题交人。
- 适用：返工轮次里，复审指出的问题与前几轮同源时。
- 为什么：数值合法性、失败重试、会话归属、外部配置解析都曾各自返工 5 轮以上，每轮只补上一个变体。PR #170 的关闭证据与重开时间在代码复审里又被连续指出多个变体。
- 这样做是对的：PR #39 改用写入方恒满足的不变式；PR #57 从复刻规则改为直接问 CLI。PR #73 在第 2 个同源变体时就列出全部能碰状态目录的入口一次收口。PR #79 最后一轮把换回流程的输入、读、写、重跑一次理清并配故障注入测试。PR #110 把路径解析改为以内核真实打开结果为标准答案、整体对拍。PR #115 在第 1 轮打回后把全部写入点列全一次收口，第 2 轮复审直接通过（https://github.com/GigleAI/cavil-loop/pull/115#issuecomment-6576980505）。PR #134 去掉「编辑评论」这一步本身，并在每个脚本步骤后跑独立消费者参考实现（https://github.com/GigleAI/cavil-loop/pull/134#issuecomment-6633742704）。PR #96 最终改设计：不改旧代码，叫醒脚本只消费原有两处解析一致的结论（https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6539296288）。PR #170 第 1 轮返工把开关开 / 关 × 时间文件 × 标记列成转移表一次重写，并补跨轮用例，第 3 轮复审通过（https://github.com/GigleAI/cavil-loop/pull/170#issuecomment-6676666474）。
- Seen 10×: #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050467714 · #39 https://github.com/GigleAI/cavil-loop/pull/39#issuecomment-5774726460 · #44 https://github.com/GigleAI/cavil-loop/pull/44#issuecomment-5882615439 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6052366557 · #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356247734 · #110 https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6568519638 · #134 https://github.com/GigleAI/cavil-loop/issues/133#issuecomment-6630889716 · #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6622602816 · #96 https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6539118408 · #170 https://github.com/GigleAI/cavil-loop/pull/170#issuecomment-6676039125

### L3
- 规则：同一条规则有多个实现或调用点（生产者与消费者、jq 与 Python、汇总与明细、多个交付入口）时，复用同一个函数、同一份文字或同一份中间结果；做不到就用同一份输入对拍全部输出，并对每个调用点单独做负对照。
- 适用：计价、计数、去重、判断「是否已有值」，以及要求同时写进多份 prompt 模板时。
- 为什么：新增 token 合计绕过金额去重；PR #62 的自审表漏了首次开 PR 和子 issue；PR #72 端口登记各按不同依据取源；PR #73 的 worker 会话判断有两份实现；PR #115 版式测试的去重掩盖了附加段缺失；PR #134 参考消费者与发送端分流依据不同；PR #104 负对照开关在 13 个入口里有 3 个放在准备步骤之后；PR #150 「迟到响应是否有效」在四个入口各一套判断；PR #96 叫醒脚本复制了一份 PR 正文关联编号规则，且 shell 与 jq 对跨行判断相反；PR #98 叫醒脚本核对写身份允许名单而 daemon 通知漏了，安装入口与公共库的新旧名选择缺同输入对拍；PR #174 颜色函数虽只有一份，但卡片、表格调用点把草稿参数固定传未知，同一条草稿 PR 在三个界面颜色不同。
- 这样做是对的：PR #64 把同一段文字写进三份指令，测试走真实拼装函数对拍成品，并对 7 个写入点逐个负对照。PR #72 认主、列表、注销共用同一枚举函数。PR #78 同一条规矩写进 5 个位置，成品逐字对拍并逐点反例（https://github.com/GigleAI/cavil-loop/pull/78#issuecomment-6355389753）。PR #83 冲突检查命令只保留一份原文，测试对每个写入点单独负对照（https://github.com/GigleAI/cavil-loop/pull/83#issuecomment-6357707726）。PR #87 daemon 与 worker 的冲突判定用同一批 6 个 PR 对拍（https://github.com/GigleAI/cavil-loop/pull/87#issuecomment-6392834732）。PR #110 信任目录规则部署与派工共用同一函数并逐入口负对照。PR #134 返工后用 7 种条目跑真实脚本与参考消费者对拍（https://github.com/GigleAI/cavil-loop/pull/134#issuecomment-6634119400）。PR #101 webhook 只有一个共用函数，两条路径各有断言（https://github.com/GigleAI/cavil-loop/pull/101#issuecomment-6544183045）。PR #104 三个入口共用 `neg_sandbox`。PR #150 四类异步入口共用同一判断。PR #121 本机、分组、CI 汇总共用同一个 `tests/run.sh`（https://github.com/GigleAI/cavil-loop/pull/121#issuecomment-6581047608）。PR #96 三个派工脚本共用 `flip_to_doing`、交接文字只有一份并对四类成品各断言恰好一次。PR #98 返工后账号资格、挑新旧名各只剩一份实现，同一批账号对拍两个入口，每个调用点各有负对照（https://github.com/GigleAI/cavil-loop/pull/98#issuecomment-6541045282）。PR #170 「这轮写不写目录经验」只算一次传入四个出口，中英两页恢复文档逐字对拍（https://github.com/GigleAI/cavil-loop/pull/170#issuecomment-6676666474）。PR #171 的 PR 归组只有一份纯函数，看板与表格同输入对拍，三个调用点各有负对照（https://github.com/GigleAI/cavil-loop/pull/171#issuecomment-6677366735）。PR #176 合并方式的默认值规则只在共享纯函数里实现一份，详情面板与控制器都调用它，面板侧（记 / 不记退回项）和控制器侧（不存）各有独立负对照（https://github.com/GigleAI/cavil-loop/pull/176#issuecomment-6677622041）。PR #174 返工后草稿标记经三条读取路径传到徽章、卡片、表格，同一条草稿 PR 三处对拍，各调用点与各读取映射有独立负对照（https://github.com/GigleAI/cavil-loop/pull/174#issuecomment-6678185657）。PR #188 卡片、表格、详情三处标签颜色统一走 `labelStyle`、删掉表格里的另一份算法，测试共用同一组透明度读取并逐处断言（https://github.com/GigleAI/cavil-loop/pull/188#issuecomment-6686152611）。
- Seen 14×: #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013473233 · #50 https://github.com/GigleAI/cavil-loop/pull/50#issuecomment-6049612213 · #55 https://github.com/GigleAI/cavil-loop/pull/55#issuecomment-6050704401 · #59 https://github.com/GigleAI/cavil-loop/pull/59#issuecomment-6052446031 · #72 https://github.com/GigleAI/cavil-loop/pull/72#issuecomment-6283696025 · #73 https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284402396 · #115 https://github.com/GigleAI/cavil-loop/pull/115#issuecomment-6576908182 · #134 https://github.com/GigleAI/cavil-loop/pull/134#issuecomment-6634119400 · #104 https://github.com/GigleAI/cavil-loop/pull/104#issuecomment-6551273717 · #150 https://github.com/GigleAI/cavil-loop/pull/150#issuecomment-6662760973 · #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6622602816 · #96 https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6538530030 · #98 https://github.com/GigleAI/cavil-loop/pull/98#issuecomment-6540708334 · #174 https://github.com/GigleAI/cavil-loop/pull/174#issuecomment-6677855164

### L4
- 规则：测试走真实执行路径和真实形状——真实子进程边界、仓库自带的多行模板与真实日志结构、真实目录布局（如 git worktree）——并断言行为，不断言源码文本。
- 适用：新增或修改测试。
- 为什么：只匹配源码的测试在 bug 存在时仍全绿；单行夹具绕过多行 prompt 缺陷；普通临时目录测不出 worktree 差异；PR #98 的安装兼容测试抽取脚本三行再 eval，没跑真实入口。
- 这样做是对的：PR #64 读仓库真实多行模板、调用派工真正使用的拼装函数断言成品。PR #73 把源码文本断言改成在主轮询子进程里探测锁是否已释放（https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284668678）。PR #79 返工后用 `env -i` 干净环境调用真实脚本。PR #81 用真实 bare remote 与全新 clone，并从 `release.yml` 读出步骤真跑（https://github.com/GigleAI/cavil-loop/pull/81#issuecomment-6356917134）。PR #83 把检查命令放进真实 git worktree 由子进程实跑（https://github.com/GigleAI/cavil-loop/pull/83#issuecomment-6357707726）。PR #87 起真实轮询子进程、bare origin 与冲突提交，假 `gh` 补齐真实接口状态字段。PR #110 用真实 git 布局，屏幕夹具取自真机截屏。PR #134 真跑叫醒脚本，用状态式假 GitHub 在请求前注入外部编辑。PR #143 把配置样例原样复制成项目配置在干净子进程里断言生效值（https://github.com/GigleAI/cavil-loop/pull/143#issuecomment-6658727879）。PR #101 真 curl 打本地真 HTTP 服务。PR #131 在隔离 HOME 下真跑安装脚本。PR #163 每轮真起轮询子进程加有状态假 GitHub 与假 tmux（https://github.com/GigleAI/cavil-loop/pull/163#issuecomment-6671908387）。PR #150 驱动真实 Electron 窗口。PR #121 真子进程调用真实入口。PR #96 起真实轮询与派工脚本、真 git 仓库、带状态假 GitHub、真实多行模板，并在复审后补上中间状态断言。PR #98 返工后在隔离目录真跑 `setup.sh`，断言实际建标签请求。PR #170 用 `env -i` 跑真实入口、真实 bare origin 与推送，单文件故障从外部注入，恢复步骤按文档原文逐字执行（https://github.com/GigleAI/cavil-loop/pull/170#issuecomment-6676666474）。PR #171 缩放走真实后台子进程加真 SQLite 重启读回，界面测试驱动真实窗口、真实拖动与按键（https://github.com/GigleAI/cavil-loop/pull/171#issuecomment-6677366735）。PR #176 控制器测试走真实 Rust 子进程加真 SQLite 重启读回，窗口测试断言假 GitHub 收到的两次合并请求（方式与提交号），不断言源码文本（https://github.com/GigleAI/cavil-loop/pull/176#issuecomment-6677622041）。PR #188 多来源回归在真实窗口里从设置页添加 20 个来源，用真实滚轮和鼠标点击，断言条目数 20→19→20，套到旧样式上变红（https://github.com/GigleAI/cavil-loop/pull/188#issuecomment-6684911159）。
- Seen 7×: #30 https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794 · #33 https://github.com/GigleAI/cavil-loop/pull/33#issuecomment-6050298312 · #48 https://github.com/GigleAI/cavil-loop/pull/48#issuecomment-6013196195 · #57 https://github.com/GigleAI/cavil-loop/pull/57#issuecomment-6051560673 · #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356118759 · #143 https://github.com/GigleAI/cavil-loop/pull/143#issuecomment-6658681202 · #98 https://github.com/GigleAI/cavil-loop/pull/98#issuecomment-6540708334

### L34
- 规则：PR 正文里的实测数字（尤其是新测试套到旧版本的通过/失败/未拦下个数）写明命令与口径，交付前复跑核对；独立复审复跑得出不同数字时，以复跑为准并在正文更正。
- 适用：PR 正文或交人评论引用对拍、负对照的计数时。
- 为什么：PR #78 正文称旧 main 上「另有 1 个反例没被拦下」，复审复跑为 4 个；PR #132 正文写负对照 58 份、已跑 12 份，复审实测当前为 55 项；PR #98 两轮正文数字（770/771、834/833）及三项负对照失败条数均与复审复跑不符；PR #174 首版正文的负对照命令写成区间，原样执行即报错、一项都不跑。
- 这样做是对的：PR #83、#85、#87、#131、#163、#121 正文的通过/失败数经复审复跑完全一致，并说明通过项为何天然满足（如 https://github.com/GigleAI/cavil-loop/pull/87#issuecomment-6392752532）。PR #170 终轮正文的 26 个用例 / 29 项负对照 / 旧基准 18 个红，经复审复跑一致（https://github.com/GigleAI/cavil-loop/pull/170#issuecomment-6676666474）。PR #171 正文的 189 注明是不依赖后台的子集，与复审全量 351 口径分开，无冲突（https://github.com/GigleAI/cavil-loop/pull/171#issuecomment-6677366735）。PR #176 正文每个数字都写了命令，并注明只跑了新增 7 项负对照、未跑全部 157 项，复审复跑 357 + 19 + 7 项一致（https://github.com/GigleAI/cavil-loop/pull/176#issuecomment-6677622041）。PR #198 正文写明命令与口径（默认模式通过 416、失败 0、负对照跳过 73），复审复跑一致（https://github.com/GigleAI/cavil-loop/pull/198#issuecomment-6686325047）。
- Seen 4×: #78 https://github.com/GigleAI/cavil-loop/pull/78#issuecomment-6355389753 · #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6619558657 · #98 https://github.com/GigleAI/cavil-loop/pull/98#issuecomment-6541045282 · #174 https://github.com/GigleAI/cavil-loop/pull/174#issuecomment-6677419671

### L41
- 规则：daemon 在判定与写 GitHub（评论、翻标签）之间必须重读目标，并把判定所依据的全部身份与状态（是否打开、是否已合并、目标分支、最新提交、来源属性、标签保护）逐项比对；任一项不符或缺字段，本轮不写、不记已处理。
- 适用：先判定、后对外写入，且两步之间有时间间隔的自动化。
- 为什么：PR #87 首版写前重读只核对提交与标签，改投分支或已合并关闭的 PR 仍被发评论并派工；PR #132 的阈值交人路径写前只保留标签，PR 已关闭仍加标签、留言并记完成；PR #98 的重试只重读旧 PR 状态，未重查是否有新 PR，也未核对写身份允许名单。
- 这样做是对的：PR #87 返工时一次列全写前依赖字段，补跨快照测试和去掉核对的负对照。PR #132 最终让交人待办在动手前用同一个接手判断现读重判。PR #98 返工后每次尝试发送前都现读完整资格并过账号名单。
- Seen 3×: #87 https://github.com/GigleAI/cavil-loop/pull/87#issuecomment-6392752532 · #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6621606711 · #98 https://github.com/GigleAI/cavil-loop/pull/98#issuecomment-6540708334

### L36
- 规则：读取外部服务状态时区分「明确的否」与「查不到」：只认已知状态词，空输出或连接失败一律算未知，未知时不记录原状、不确认停止、不收尾，保留旧状态留待下一轮。
- 适用：脚本依赖 systemctl 等状态查询来决定迁移、停止或删除时。
- 为什么：PR #79 初版把服务管理器连不上当成「原本不开」和「已停」，收走旧登记并删除旧入口；PR #98 初版把打开 PR 列表读取失败当成「没有别的 PR」，照发关闭通知；PR #170 初版把目标分支取不到当成「主干上没有报告」而永久跳过任务，并把读不出的时间文件当成「已关闭」。
- 这样做是对的：PR #79 返工后列出全部 4 处读状态点，各自做反例并配对旧提交的负对照。PR #81 查 Release 列表失败时直接失败，不猜有无。PR #83 冲突检查取不到时判「检查失败」而非「无冲突」。PR #87 daemon 判不了时不写任何东西、下轮再判。PR #98 返工后列表读失败判未知、留队，恢复后再判。PR #170 返工后先确认分支能解析成提交再读目录树，失败算未知、任务字节不变。PR #176 详情没读到允许的合并方式时不显示合并区、不写记录，自动退回项从不写入，并有真实窗口场景加负对照（https://github.com/GigleAI/cavil-loop/pull/176#issuecomment-6677622041）。PR #174 详情读取失败时草稿标记回退到看板值，两处都没有就不判草稿，502 场景有真实窗口断言（https://github.com/GigleAI/cavil-loop/pull/174#issuecomment-6678185657）。
- Seen 3×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6355975783 · #98 https://github.com/GigleAI/cavil-loop/pull/98#issuecomment-6540708334 · #170 https://github.com/GigleAI/cavil-loop/pull/170#issuecomment-6676039125

### L38
- 规则：写给人照做的恢复或运维步骤，要在干净环境按文档字面逐条执行验证，覆盖进入、操作、退出、检查到回退的完整生命周期，且不由夹具额外导出变量；文档承诺的回退条件必须在回退时点仍成立。
- 适用：文档里新增人工处理步骤或恢复命令时。
- 为什么：PR #79 初版文档的端口变量传不进持锁子 shell，且承诺的「旧入口仍保留」在最后一个冲突处理后已不成立；PR #105 的对接文档与流程表对机器人回复位置的要求冲突，按字面操作会重新派发 issue；PR #170 的恢复步骤先是备份失败仍继续删除重启，后又承诺「时间文件未变」而重启失败时文件已被删。
- 这样做是对的：PR #170 返工后每步以失败门控结尾，输出区分「未重置」与「已重置但轮询未恢复」，并逐字执行加逐步注入失败。
- Seen 3×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356118759 · #105 https://github.com/GigleAI/cavil-loop/pull/105#issuecomment-6551408884 · #170 https://github.com/GigleAI/cavil-loop/pull/170#issuecomment-6676403154

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
- 这样做是对的：PR #174 合入主干后核对 #171 的新约定（时间线条目改为可折叠），同步修改徽章测试的等待条件，并重跑完整回归（https://github.com/GigleAI/cavil-loop/pull/174#issuecomment-6677520294）。
- Seen 1×: #26 https://github.com/GigleAI/cavil-loop/pull/26#issuecomment-6050113829

### L9
- 规则：判定人工是否已拍板，落到具体评论 URL、时间戳和正文核对，不凭「最新评论是自己发的」或「label 已翻回」推定；只有 relabel 时写「未见书面确认，按默认项执行」，查不到勾选编辑者就写「出自谁未验证」。
- 适用：复盘、审计、派工判断人工意图时。
- 这样做是对的：PR #68、#72、#73、#77、#78、#79、#83、#85、#87、#101、#104、#105、#110、#121、#132、#134、#150 的正文与复审均明写只见重新打标签、未见书面确认，勾选人未验证，按方案原样/默认执行，不把 relabel 当授权。PR #96 的复审同样写明勾选编辑者未独立核验（https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6538713088）。PR #98 正文与复审同样标明勾选编辑者未验证（https://github.com/GigleAI/cavil-loop/pull/98#issuecomment-6541045282）。PR #171 同样写明头像题只见 relabel、Esc 题勾选人未验证（https://github.com/GigleAI/cavil-loop/pull/171#issuecomment-6677366735）。
- Seen 1×: #30 https://github.com/GigleAI/cavil-loop/pull/30

### L11
- 规则：测试全绿、复审「实测通过」、PR 合并、生产已实际执行分别声明，不互相代替；「实测过的 / 没跑过的」分栏披露。改到复审/派工自己运行时依赖的脚本或模板时，同时声明「合并部署前仍用旧版」的验证滞后。
- 适用：交人评论、复审结论、复盘里提到验证或上线状态。
- 这样做是对的：PR #64 起的多个 PR（#68、#72、#73、#78、#77、#79、#81、#83、#85、#87、#96、#98、#101、#104、#105、#110、#115、#121、#131、#132、#134、#143、#150、#163、#170、#171）均单列「还没验证的」，复审区分自报与独立复跑，例如 PR #101 把自报 1124 更正为独立复跑的 1125（https://github.com/GigleAI/cavil-loop/pull/101#issuecomment-6544324626），PR #96 单列真实 GitHub/grokbot 未跑、部署前仍是旧版（https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6539637660）。PR #198 明写“文档写对不等于机器人已照做”，真实机器人效果待观察（https://github.com/GigleAI/cavil-loop/pull/198#issuecomment-6686325047）。
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
- 为什么：PR #73 初版在拿锁之前枚举会话判断空闲，判断过期后仍搬走刚派出 worker 的项目；第 2 轮又发现只看一次进度文件，并发轮询仍能绕过暂停；PR #170 的恢复步骤用 `flock … true` 拿锁即放，备份和重置不在互斥内，在途复盘仍可插入。
- 这样做是对的：PR #73 返工后先拿项目轮询锁再判断空闲，并让迁移锁的共享侧覆盖整段，用真实子进程交错测试。PR #170 返工后以文件描述符持锁到重置完成，并在恢复中途真跑入口断言无变化。
- Seen 2×: #73 https://github.com/GigleAI/cavil-loop/pull/73#issuecomment-6284402396 · #170 https://github.com/GigleAI/cavil-loop/pull/170#issuecomment-6676403154

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

### L35
- 规则：检查「任意时刻最多一段可见」这类时序属性时，把全部动画的切换时间合并、按恒定小区间逐段判定，不靠固定间隔采样；并配一个短于旧采样间隔的负对照，证明旧检查放过、新检查拦下。
- 适用：为动画、定时切换等离散时序行为写自动检查时。
- 为什么：PR #77 的检查器每 0.05 秒采样一次，复审把第二段说明额外闪现 0.01 秒后整套测试仍全绿。
- 这样做是对的：PR #77 返工后改为按全部切换点切段，新增 2 个短暂错误负对照，并用上一版检查跑同一套测试证明能区分新旧。
- Seen 1×: #77 https://github.com/GigleAI/cavil-loop/pull/77#issuecomment-6355385064

### L37
- 规则：替换关键登记或配置文件时，先备份再在同目录原子覆盖，新内容就位前不制造「两处都没有」的空位；测试注入替换中途失败，断言原登记仍在且重跑能完成。
- 适用：恢复、换回、迁移等会改写登记文件的流程。
- 为什么：PR #79 的换回脚本先 mv 走现登记再 mv 入新文件，第二步失败后登记消失且重跑被拒。
- Seen 1×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356247734

### L39
- 规则：用备份恢复前，先在持锁后、任何停止或写入之前核对备份记录的端口、内容里的端口，以及当前登记仍是当初留下的那一份；对不上就拒绝并保持所有状态不变，测试逐字节核对。
- 适用：提供备份换回、回滚类命令时。
- 为什么：PR #79 的换回命令接受另一端口的备份，覆盖了无关项目的登记并报告成功。
- Seen 1×: #79 https://github.com/GigleAI/cavil-loop/pull/79#issuecomment-6356247734

### L40
- 规则：多步外部副作用流程（如先推 tag 再建页面）判断「是否已完成」时，以最终产物为准，不以中间产物代替；测试必须含「前一步成功、后一步失败、全新环境重跑」的场景，并对旧实现做负对照。
- 适用：定时或手动可重复触发的发布、迁移、同步类自动化。
- 为什么：PR #81 首版把「HEAD 已有 tag」当作「已发布」，推 tag 后建页面失败时，重跑不会补建页面；首版 50 条测试全绿，靠复审故障注入才发现。
- 这样做是对的：PR #81 返工后，以仓库 Release 列表判断是否已发布，只有 tag 没页面时沿用该 tag 补建，并配故障注入和多组负对照。
- Seen 1×: #81 https://github.com/GigleAI/cavil-loop/pull/81#issuecomment-6356803540

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
- 为什么：PR #110 一项负对照在子 shell 里准备失败，失败计数传不回父进程，整套仍报「通过 146，失败 0」；PR #98 同样因命令替换吞掉准备失败，整套报绿却漏跑一项负对照。
- 这样做是对的：PR #104 保留 `REQUESTER_BOT_TEST_BAD_MUT=1` 自检：唯一失败是故意制造的准备失败。PR #94 在交付前自查发现 comment-footer 测试经管道送进计数、失败进不了退出码，改为进程替换后两者一致（https://github.com/GigleAI/cavil-loop/pull/94）。PR #98 返工后准备失败写入父进程可读记录，自检开关使整套退出码为 1。
- Seen 2×: #110 https://github.com/GigleAI/cavil-loop/pull/110#issuecomment-6568519638 · #98 https://github.com/GigleAI/cavil-loop/pull/98#issuecomment-6541045282

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
- 为什么：PR #115 发现设计复审对拍把主干的模板当旧基准，任何只改模板文字的 PR 都红 10 条；单元链接修复测试的旧部署器取主干，#111 合并后「问题重现」恒红。
- 这样做是对的：PR #134 把 6 条不变红的负对照基准固定到 #106 合并前的提交，6 条变红（https://github.com/GigleAI/cavil-loop/pull/134#issuecomment-6633742704）。PR #105 在交付前自查，改成用旧拼装代码拼本版模板（https://github.com/GigleAI/cavil-loop/pull/105）。
- Seen 1×: #115 https://github.com/GigleAI/cavil-loop/pull/115

### L48
- 规则：把运维者配置的值（地址、请求头等）交给 curl、shell 等带展开或转义语义的工具时，测试里必须有一条含该工具元字符的输入（如 `[1-2]`、`{a,b}`），真跑并断言对端实际收到的请求，再做关掉对应开关的负对照。
- 适用：向外部地址发请求、拼装命令行或配置文本的脚本。
- 为什么：PR #101 初版把地址经标准输入传给 curl，curl 默认仍展开 `[1-2]`，一次叫醒发出多次请求，成功被误报为连接失败，1118 条测试全绿仍没发现。
- 这样做是对的：返工后在共享函数加 `--globoff`，叫醒与结果通知两条真实路径用同一含元字符的地址各补断言，去掉保护后两边都变红。
- Seen 1×: #101 https://github.com/GigleAI/cavil-loop/pull/101#issuecomment-6544006826

### L49
- 规则：给慢速或重复性检查（如负对照）加「默认跳过」开关时，把开关判断放在第一个复制、改文件、建沙盘等准备步骤之前，并在关闭模式下用副作用计数（建了几个沙盘）断言准备确实没执行，不只断言汇总文字。
- 适用：新增或修改带开关、可跳过的测试入口，尤其是多个测试各自接入同一开关时。
- 为什么：PR #104 初版把 `mutation_gate` 放在 `expect_red()` 内，三个提示词测试在默认模式仍建了 13、16、12 个沙盘并改模板，汇总却显示「跳过」。
- 这样做是对的：PR #104 返工后统一用 `neg_sandbox` 先过开关再建沙盘，默认模式断言沙盘数为 0。PR #105 解冲突后把新增负对照每项先在主 shell 调 `mutation_gate`（https://github.com/GigleAI/cavil-loop/pull/105#issuecomment-6554555631）。
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
- 为什么：PR #163 初版耗尽即删记录，而本机清理持续失败使该 issue 每轮重新入队，计数归零，上限形同虚设。
- 这样做是对的：返工后改为记「已结束」、入队保留已有值、清理成功才删，并对四个入口各做负对照。
- Seen 1×: #163 https://github.com/GigleAI/cavil-loop/pull/163#issuecomment-6671552367

### L53
- 规则：约定「只和某些域名通信」的客户端，对详情、预览等加载外部内容的入口，要在真实窗口里记录实际发出的网络请求，断言允许的域名发出、禁止的域名零请求；不能只断言内容安全策略字符串。
- 适用：桌面或网页客户端渲染 GitHub 返回的 HTML、图片、媒体时。
- 为什么：PR #150 初版放开任意 HTTPS 图片，复审用真实 Electron 观察到 camo 域名请求，现有测试只检查策略字符串而全绿。
- 这样做是对的：PR #150 返工后页面策略加主进程请求过滤双层限制，并用请求记录做正反断言。PR #171 在真实窗口记录请求，头像域名有请求、图片代理与附件零请求，并配改回通配的负对照（https://github.com/GigleAI/cavil-loop/pull/171#issuecomment-6677366735）。
- Seen 1×: #150 https://github.com/GigleAI/cavil-loop/pull/150#issuecomment-6662127445

### L54
- 规则：读取带嵌套列表的分页接口（如评审下的逐行评论）时，外层和每个内层列表都要翻页读完再合并排序；任何一页失败整次报错，不显示成完整内容；测试用超过单页上限的数据和后续页失败各补一条。
- 适用：读取评论、评审、文件列表等 GraphQL 或 REST 分页数据时。
- 为什么：PR #150 初版每个评审只取前 100 条逐行评论，101 条时少一条且页面只提示「在网页上看」。
- Seen 1×: #150 https://github.com/GigleAI/cavil-loop/pull/150#issuecomment-6662127445

### L55
- 规则：新增 CI 或把测试搬到干净机器前，用最小环境模拟预检：固定时区、不带全局 git 配置，并在测试里显式指定假仓库的分支名、清除外层 CI 变量；首次真实 CI 的失败逐个查明是测试依赖开发机还是产品问题。
- 适用：把本机手动跑的测试首次接入 CI，或新增会建临时 git 仓库、读时间的测试时。
- 为什么：PR #121 首次 GitHub 运行 5 个测试失败：假仓库跟随本机默认分支、夹具时区跟随本机、外层 CI 变量漏进被测运行。
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
- 为什么：PR #132 的组合表把"接手且 PR 没标签"一行的预期强改为不接手，等于把错误行为固定成了预期，默认回归全绿仍放过了缺陷；PR #174 的界面测试把草稿 PR 的卡片颜色预期写成绿色，与「配色与 GitHub 一致」的要求相反，测试全绿也不能证明符合需求。
- 这样做是对的：PR #174 返工后把该行预期改为灰色，并注明按 GitHub 规则推导、不照实现抄。
- Seen 2×: #132 https://github.com/GigleAI/cavil-loop/pull/132#issuecomment-6619558657 · #174 https://github.com/GigleAI/cavil-loop/pull/174#issuecomment-6677855164

### L58
- 规则：交人拍板的问题先用一个真实使用场景讲清「以前怎样、选了之后谁要多做什么」，标题和选项不用函数名、解析方式等代码内部说法；发出前只读标题、第一段和选项自查能否做选择。
- 适用：worker 或复审在 issue / PR 评论里写勾选题时。
- 为什么：PR #96 复审把「是否不再给仅在正文关联需求的 PR 转话」做成 A/B 题，维护者回复看不懂，复审随后补写场景并改按默认退回。
- Seen 1×: #96 https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6539409187

### L59
- 规则：复用为别的用途设计的函数时，先核对它在「找不到 / 失败」时的兜底行为是否适合新用途；兜底与新用途相反就拆开或不用，并补一条走兜底路径的拒绝用例。
- 适用：安全或来源核验代码借用命名、路由等通用辅助函数时。
- 为什么：PR #96 叫醒脚本借用会话命名的编号函数，找不到关联 issue 时退回 PR 自身，机器人自开的无关联 PR 通过了来源核验。
- Seen 1×: #96 https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6538371153

### L60
- 规则：修改默认关闭功能所依赖的共享代码（解析、编号、派工选择）后，关闭模式要与固定旧基准按同一批输入逐条对拍，并经过真实消费者（如派工选会话）；只在开启模式对拍不算。
- 适用：为可选功能统一或重写既有共享逻辑时。
- 为什么：PR #96 把共享正文解析改为整段匹配后，全套 784 条测试全绿，功能关闭的项目 PR 工作编号仍由 65 变 50。
- Seen 1×: #96 https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6539118408

### L61
- 规则：对「先移除再添加才会触发通知」这类多步写操作，每步写后读回并断言中间状态，注入「返回成功但不生效」的故障；只断言调用顺序不算验证。
- 适用：依赖状态变化事件（指派、标签）触发外部动作的脚本。
- 为什么：PR #96 初版移除 assignee 假成功时仍退出 0 报叫醒成功，测试只检查 DELETE、POST 的顺序。
- Seen 1×: #96 https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6538371153

### L62
- 规则：为绕开技术问题而删减原需求支持的范围，属于范围变更：不得靠改测试预期或自行定案了事，须按使用后果交人确认，未确认前保留原要求。
- 适用：返工中发现实现难以兼容某类输入、想以「不支持」收口时。
- 为什么：PR #96 某轮把「仅正文关联的 PR」直接改为拒绝并把测试预期改成拒绝，复审指出人工并未授权缩小范围。
- Seen 1×: #96 https://github.com/GigleAI/cavil-loop/pull/96#issuecomment-6539338765

### L63
- 规则：「标记触发一次动作、动作成功后再清标记」的流程里，清标记失败时必须让「该标记已用过」可持久识别，下一轮只重试清理，不得重复执行动作；测试连跑清理持续失败再恢复的多轮，断言结果不变。
- 适用：重开计时、一次性补偿、重试队列等依赖残留标记的跨轮状态。
- 为什么：PR #170 初版在写好新开始时间后吞掉清标记失败，下一轮只见标记仍在，又重新计时，恰在新开始时间合并的任务被永久跳过。
- 这样做是对的：PR #170 返工后把标记存进时间文件记作已用过，用例连跑 4 轮开始时间不变。
- Seen 1×: #170 https://github.com/GigleAI/cavil-loop/pull/170#issuecomment-6676039125

## 目录经验

### L64
- 规则：给客户端全局快捷键（如 Esc 关闭）写回归时，把焦点所在位置作为变量，至少覆盖外层页面、隔离 iframe 内点击后、输入框三种，并用真实键盘事件；不要只在焦点在外层时测。
- 适用：客户端详情面板等把不可信内容放进隔离 iframe、同时靠外层窗口监听按键的界面。
- 为什么：PR #171 的 Esc 回归在拖宽后按键，焦点仍在外层；点过隔离框里的讨论后按 Esc，外层收不到，详情关不掉，靠复审用真实键盘才发现。
- 这样做是对的：返工后在真实窗口点隔离框内的折叠标题、按 Esc、再点面板标题、再按 Esc，断言面板先留后关，并在 README 写明用法。
- Seen 1×: #171 https://github.com/GigleAI/cavil-loop/pull/171#issuecomment-6676374392 [client/src/renderer/]

### L65
- 规则：客户端界面测试在切换系统深浅色等由事件驱动重绘的状态后，不要立刻读计算样式；先轮询窗口模式和页面上全部相关元素的实际样式达到目标，再做原有断言，不用固定延时，也不放宽阈值。
- 适用：client/test/e2e/ 里用 emulateMedia 切换主题后检查颜色、透明度、对比度的 WebKit/Chromium 界面测试。
- 为什么：PR #188 的深色标签检查在切换后立即读取背景，本机 Chromium 事件发出时已重绘而通过，CI 的 WebKit 有间隙，读到不透明背景而失败。
- 这样做是对的：PR #188 改为轮询模式和每个标签的实际背景，并把详情标签临时改成实心色验证测试仍会变红（https://github.com/GigleAI/cavil-loop/pull/188#issuecomment-6685860398）。
- Seen 1×: #188 https://github.com/GigleAI/cavil-loop/pull/188#issuecomment-6684911159 [client/test/e2e/]

### L66
- 规则：客户端顶栏等数量由用户数据决定的区域（来源、标签）不得用不可滚动的裁剪容器，也不能靠收缩子项让内容消失；界面测试用超过可视宽度的数据（如 20 个来源）在 1024 与常规宽度下，用真实滚轮和点击访问末尾项并断言选择生效，不只断言外层不溢出。
- 适用：client/src/renderer/ 里顶栏、工具条等数量可变的横向布局。
- 为什么：PR #188 把来源区设为不换行、可收缩且 overflow:hidden，20 个来源时末尾复选框落在裁切区外，其中心实际命中搜索框；原有的顶栏宽度检查只测外层容器，示例只有 2 个来源，没有拦下。
- 这样做是对的：PR #188 返工后来源条可横向滚动、胶囊不收缩，新测试 20→19→20，套到旧样式上变红（https://github.com/GigleAI/cavil-loop/pull/188#issuecomment-6684794762）。
- Seen 1×: #188 https://github.com/GigleAI/cavil-loop/pull/188#issuecomment-6684429031 [client/src/renderer/]

### L67
- 规则：重构把某段被负对照（mutations.mjs）当作替换原文的代码抽成共享函数或删除时，在同一提交里把对应变异改指向新调用点，并在交付前跑 `node test/mutation/run.mjs --check`；不得靠删掉该条保护消除检查错误。
- 适用：client/test/mutation/ 的负对照清单与被它引用的 client/src/ 代码一起被重构时。
- 为什么：PR #222 抽出共享的里程碑选择函数后，一条旧负对照仍寻找已删除的内联代码，静态检查退出码 1；默认 `npm test` 只跳过负对照，578 条单元测试全绿也发现不了，会让每周发版门禁因准备失败变红。
- 这样做是对的：PR #222 返工后把变异改到详情里的真实调用点，保留「无同名里程碑则拒绝」的覆盖，静态检查 317 项原文都在（https://github.com/GigleAI/cavil-loop/pull/222#issuecomment-6699647411）。
- Seen 1×: #222 https://github.com/GigleAI/cavil-loop/pull/222#issuecomment-6699572556 [client/test/mutation/]
