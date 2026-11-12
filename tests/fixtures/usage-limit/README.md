# 用量上限提示的屏幕样本（GitHub#341）

`scripts/usage_limit.py` 认「agent 撞到用量上限」用的整屏文字，一个文件一屏（`tmux capture-pane -p` 的形状）。
来源是本机 worker 窗格日志（原始终端字节流）：按当时的窗格宽度喂进一个 tmux 窗格回放，到提示出现的那一刻截屏。
私有内容（路径、链接、任务名、上文的派工说明）已替换，提示本身和它下面 CLI 自己画的行一个字没动。

| 文件 | 是什么 | 怎么来的 |
|---|---|---|
| `claude-limit.txt` | claude 撞会话上限，不带「到点自动继续」，下面还挂着任务清单 | 回放截屏（208 列） |
| `claude-limit-autocontinue.txt` | claude 撞会话上限，带「到点自动继续」 | 那次回放的窗格宽度对不上、截出来的屏有错位，这里按回放里读得清的各行原文抄成一屏 |
| `codex-limit-dialog.txt` | codex 撞上限，下面弹着「要不要换模型」 | 回放截屏（80 列，提示被 codex 自己折成两行） |
| `codex-limit-composer.txt` | codex 撞上限，弹框已关、回到输入框 | 上一屏的提示 + 另一屏真实截到的输入框和状态行拼成（这一刻的回放同样错位） |
| `claude-limit-then-prompt.txt` | 反例：撞上限之后人敲了 continue，agent 又在干活 | 回放截屏 |
| `claude-limit-reset-continued.txt` | 反例：上限已解除、自动继续了 | 按回放里读得清的各行原文抄成一屏 |
| `claude-weekly-warning.txt` | 反例：「已用 77% 周额度」的提醒，不是撞上限 | 回放截屏（80 列） |
| `codex-resets-available.txt` | 反例：codex 开场的「还有 1 次重置可用」 | 回放截屏（80 列） |

没有样本的：周上限撞满的屏、CLI 启动就退出时的屏。规则不为它们写匹配。
