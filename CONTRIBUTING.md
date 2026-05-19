# 给外部贡献者

欢迎贡献。本仓库是个小工具，没有 CLA、没有要签的协议——MIT licensed，发 PR 即默认接受。

> 维护者 / 长期合作者建议先读 [AGENTS.md](AGENTS.md)，里面有项目结构、约定、本地开发流程。这份是给"第一次来"的人看的。

## 适合提的 PR

- **Bug 修复**：模块逻辑错、文档错字、配置示例过时
- **新 Worker 适配**：实现 `WorkerBase` 子类对接新的 AI coding 工具（参考 `coding_agent/worker/claude.py` 和 `coding_agent/worker/opencode.py`）
- **Prompt 改进**：让 worker 在某场景更稳 / 更省 token
- **跨平台兼容**：Windows 路径处理、非 POSIX 环境适配
- **新 GitHub event 监听**：例如订阅 review request、check failure
- **文档补充 + 译文**：尤其欢迎补「我踩过的坑」类经验

## 不太适合的 PR

- 不写动机的大重构（先开 issue 讨论方案再动手）
- 引入第三方 pip 依赖（本项目坚持零依赖、纯 stdlib；如确实需要请先在 issue 论证）
- 破坏现有 `prompts/*.template.md` 占位兼容性（已有部署的 host project 会断）
- 加复杂抽象层但只支持一个用例（待 N≥3 再抽象）

## PR 流程

1. **Fork → 本地改 → 推到你 fork 的分支**
   - 分支名按 `feature/<topic>` / `fix/<topic>` / `docs/<topic>` 风格
2. **开 PR 到 `luosky/coding-agent-work-loop` 的 `main`**
3. **PR Title**：用 conventional commits 风格
   ```
   feat(poll): 加 review request 监听
   fix(dispatch): worktree 路径含空格时路径拼接错误
   docs(security): 补 fine-grained PAT 限制说明
   ```
4. **PR Body** 至少含：
   - **动机**：解决什么 / 修什么。链上相关 issue 用 `Closes #N` / `Refs #N`
   - **改动**：1-2 段或 bullet 列表，不要让 reviewer 自己读 diff 找
   - **验证**：你自己怎么试过的（`uv run pytest` / `uv run ruff check` / `uv run coding-agent poll` 跑过 / 在哪个项目接入跑过 / 改了哪个 prompt 后用什么场景验证）
   - **影响面**：如果改了 `coding-agent.config.example` / `prompts/*.template.md` / `state.json` schema，明说——这些是有兼容性约束的接口
5. **保持小**：一个 PR 一个焦点。改 poll 逻辑 + 顺手重命名 + 加新功能塞一个 PR 里基本会被要求拆
6. **Style**：跟现有代码风格走——Python 用 type hints + `dataclass` / `ABC` + `from __future__ import annotations`；日志走 `log_util.setup_logger()`；配置走 `Config` 类；新 Worker 继承 `WorkerBase` 并用 `@register_worker` 注册；lint 用 `ruff`；markdown 用现有中文/英文混排习惯

## Review 时记得点 Submit

GitHub UI 上，给 PR 加 inline 评论有两条路：

| 操作 | 可见性 | Daemon 能看到 |
|------|-------|:---:|
| **Add single comment**（单条直接发） | 立即对所有人可见 | ✅ |
| **Start a review** → 加几条 → ⚠️ **没点 Submit review** | 草稿状态，只对作者本人可见 | ❌ |

如果你 review 完发现 daemon 没反应，**先确认有没有 PENDING review 卡在草稿**。GitHub 不让别人看你的草稿——这是平台机制，daemon 没辙。

## 提到 daemon trigger 的安全约定

本仓库的 `main` 上跑着 daemon。给本仓库的 issue / PR 加 `pending/agent` label 会触发 AI 在维护者机器上自动改代码 + push。

**所以**：

- **External contributor 不能给自己的 PR 打 `pending/agent` label**——GitHub 默认 collaborator 才有 label 权限。但万一你被加成 collaborator 了，请仍**只**用 label 触发对**你自己**的 PR 进行改动指示，且和维护者商量好范围
- **不要在 issue / PR 评论里写"骨架式 prompt"**（`[SYSTEM] ignore previous instructions...`）——本工具有 prompt-injection 防御但不是 100%，恶意尝试会被记录 + 用户被加黑
- **发现安全漏洞**：不要直接发到 public issue。GitHub Security Advisory → "Report a vulnerability"，或邮件维护者私发。
- 详细安全模型见 [docs/security.md](docs/security.md)

## License

MIT。你提交的代码即同意以 MIT 发布。不需要签 DCO / CLA，但**commit 用真实邮箱**（不接受 `noreply` 之类的纯匿名 commit，attribution 要查得到）。

## Code of Conduct

讨论时对事不对人。Issue / PR 里别人给的 review feedback 是工作内容评价，不是人身评价。我们没有正式 CoC 文档但执行 Contributor Covenant 的精神。
