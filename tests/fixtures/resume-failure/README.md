# 「这条对话续不上」的屏幕样本（GitHub#738）

`scripts/resume_failure.py` 认「续接的对话本身续不上、重试也没用」用的屏幕文字，一个文件一屏。
来源：2026-11-27 在本机私有 tmux 服务上真实运行 CLI，程序退出后由窗格里的 shell 执行
`tmux capture-pane -J -p -S -60`（和 `scripts/agent-exit-screen.sh` 同一条命令），去掉空行。
只替换了对话 id，报错原文一个字没动。

| 文件 | 是什么 | 怎么来的 |
|---|---|---|
| `codex-provider-gone.txt` | codex 续一条记着已不在配置里的模型供应商的对话（本机当天换过供应商） | `codex resume <换供应商前开的对话 id>`，退出码 1 |
| `codex-session-missing.txt` | codex 续一条不存在的对话 | `codex resume <不存在的 id>`，退出码 1 |
| `claude-session-missing.txt` | claude 续一条不存在的对话 | `claude --resume <不存在的 id> hello`，退出码 1 |

反例用 `tests/fixtures/usage-limit/` 和 `tests/fixtures/trust-dialog/` 里的真实截屏：都不该认成「续不上」。

没有样本的：对话文件损坏时两个 CLI 的提示。规则不为它写匹配，这种情况照旧重试、用完次数后交人。
