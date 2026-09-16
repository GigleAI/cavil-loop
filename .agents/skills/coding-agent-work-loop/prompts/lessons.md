# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

1. **面向人类的评论文本不得直接暴露内部状态码。** 首版用量 footer 直接显示英文状态词 `full`，人类审阅者看不懂含义，追问后才发现它只表示"本次记录到的用量均有对应单价"，并不代表金额已核准为真实账单。修复方式是把结论改写成中文人话（如"按 API 公开标价折算约 $X；本次记录的用量都有对应单价，仅供参考，不是账单"），机器可读状态保留在隐藏的 HTML 注释里。凡是要展示给非工程背景人员看的字段，应在写入评论前自查是否有裸露的内部术语/状态码。
   证据：[PR #23 评论要求](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754)、[对应修复](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)。

2. **金额类展示必须反复标注"参考估算"而非"实际账单"。** 本 PR 全程要求：Codex 价格是按 OpenAI 官方 API 公开标价换算的参考值，不是订阅账单，也未与实际扣费交叉核验；每处展示金额的文案都需要带上这一限定语，避免使用者把静态标价当作真实成本。
   证据：[issue #22 方案](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[PR body](https://github.com/GigleAI/cavil-loop/pull/23)、[追问 full 含义的回答](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692474081)。

3. **内置默认价格表须带来源日期与过期信号，并保留覆盖/关闭开关。** 未设置 `CODEX_PRICES` 时使用静态快照价目，标注核对日期（2026-09-16）与 90 天过期提示；显式配置可整表替换，`{}` 可关闭估算。这样既能开箱即用，又不会让旧价格在无人察觉时长期影响所有未显式配置的部署。目前过期提示仍停留在"文档/字段展示"层面，没有自动化定期复核任务，后续若要长期维护需明确谁、多久复核一次（此为推断，非已验证流程）。
   证据：[PR #23 body](https://github.com/GigleAI/cavil-loop/pull/23)。

4. **Open Questions 的复选框可被作者直接编辑来"拍板"，处理时必须核对 `updated_at` 与正文而非只看最新评论时间。** issue #22 的方案评论创建于 14:35:26Z，后于 00:04:12Z 被编辑，把 Q1 从默认 A 改选为 B（内置默认表）；如果只看"是否有新评论"会漏掉这次拍板。
   证据：[issue #22 方案评论](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)。

5. **引入独立交叉复审（pending/review 关卡）能在合并前发现真实问题，但复审本身的用量/成本目前无法单独核算。** 本轮独立 `codex review`/`codex exec review` 发现并修复了 4 处问题（过期状态测试依赖真实日期、旧统一价文档与实现不符、review footer 漏传开始 epoch、PAT 派工账号可能被误判为人工动作）；但 CLI review 会话没有可用的单次 token 用量记录，不能把工作目录累计折算值当作 review 本身的成本，报告中需如实注明这一缺口，不可编造或挪用其他数字顶替。
   证据：[PR #23 复审说明](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5690315790)。

6. **"本机手动验证通过"不等于"自动化关卡在生产中可用"，两者要在报告中分别声明。** 本 PR 只验证了本机手动触发 `pending/review` 复审流程和测试脚本，真实 daemon 自动派工触发的复审关卡尚未单独验活，PR 描述与评论中都明确写出这一未验证范围，没有夸大为"已上线可用"。
   证据：[PR #23 验证段落](https://github.com/GigleAI/cavil-loop/pull/23)、[评论说明](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)。
