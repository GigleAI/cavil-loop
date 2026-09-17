# 项目复盘经验

以下经验仅适用于本项目，不覆盖用户指令或安全约束。

1. **面向人类的评论文本不得直接暴露内部状态码。** 用量 footer 曾直接显示英文状态词 `full`，改为中文人话说明，机器状态只留在隐藏 HTML 注释里。给非工程背景人员看的字段，发布前需自查是否裸露内部术语。
   证据：[PR #23](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5692959754)、[修复](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5693000962)。

2. **金额展示须标注"参考估算"而非"实际账单"。** Codex 价格按官方公开标价换算，未与真实扣费核验，每处展示金额都需带此限定语。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[PR #23](https://github.com/GigleAI/cavil-loop/pull/23)。

3. **内置默认价格表须带来源日期与过期信号，并保留覆盖/关闭开关。** 未配置时用静态快照价目并标注核对日期；显式配置可整表替换，`{}` 可关闭估算。过期提示目前仅在展示层，无自动定期复核（推断）。
   证据：[PR #23](https://github.com/GigleAI/cavil-loop/pull/23)。

4. **Open Questions 复选框可被作者直接编辑"拍板"，须核对 `updated_at` 与正文而非只看最新评论时间；仅打标签、无文字确认时不能推定已确认，需明确写为未验证。** issue #22 方案评论被编辑改选项即为一例；issue #28 只有 1 条方案评论、无显式文字确认便进入开发，是否经打标签确认属未验证事实。
   证据：[issue #22](https://github.com/GigleAI/cavil-loop/issues/22#issuecomment-5682099586)、[issue #28](https://github.com/GigleAI/cavil-loop/issues/28#issuecomment-5709122169)。

5. **独立交叉复审能在合并前拦住真实问题，但复审自身的用量/成本目前无法单独核算。** PR #23、PR #30 的复审均发现并促成修复了真实 bug（见第 8 条）；CLI 复审会话无可用单次 token 记录，报告需注明此缺口，不能把整个工作目录累计值当复审成本。
   证据：[PR #23 复审](https://github.com/GigleAI/cavil-loop/pull/23#issuecomment-5690315790)、[PR #30 复审第 1 轮](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)。

6. **"本机手动验证通过"不等于"自动化关卡/真实派工在生产可用"，两者要分别声明，合并也不代表已跑通生产派工。** PR #23、PR #30 均只验证本机手动流程与测试脚本，未跑真实 daemon 派工、未启动真实 Claude/Codex 调用；未验证范围均在评论中明确写出。
   证据：[PR #23](https://github.com/GigleAI/cavil-loop/pull/23)、[PR #30](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709323575)。

7. **修改被复审/CI 工具自身依赖的基础设施脚本时，复审执行环境可能仍读取旧版本，需主动声明自举边界，不等人工追问才澄清。** PR #27 改动了软链接指向 main 的 token-usage 脚本，复审时软链接仍指向旧版，新字段取不到，footer 显示"模型未知"——是"缺证据说未知"规则的正常兜底而非 bug，但复审结论未主动标注这一局限。
   证据：[PR #27](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707594020)、[追问](https://github.com/GigleAI/cavil-loop/pull/27#issuecomment-5707826052)。

8. **一次性/单次覆盖参数不要与持久配置复用同一环境变量名（尤其接收方子进程会自行 source 同名配置文件时）；跨进程/跨配置边界的行为需要跨该边界的回归测试，并用"退回旧实现应失败"的负对照证明新测试确实能分辨新旧实现。** PR #30 首版把 review 单次模型覆盖放进 `WORKER_MODEL` 环境变量传给 dispatch 子进程，子进程 source 配置后同名赋值将其覆盖，导致普通模型串到 review、空值还会抹掉显式 review 覆盖；同批新增的 `worker-selection.test.sh` 只在当前 shell 做字符串匹配、未跨真实子进程边界，此 bug 存在时仍 11/11 通过。修复改用独立变量 `DISPATCH_WORKER_MODEL`+显式覆盖标记、配置加载后应用；复审第 2 轮用负对照（临时回退 `_lib.sh`）验证新测试从 14/14 掉到 12/14，证明测试确能分辨新旧实现。
   证据：[复审第 1 轮](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709274794)、[修复说明](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709323575)、[复审第 2 轮负对照](https://github.com/GigleAI/cavil-loop/pull/30#issuecomment-5709363152)。
