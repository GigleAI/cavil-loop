# scripts/ — 已废弃

这些 bash 脚本已被 `coding_agent/` Python 包替代，仅保留供参考。

请使用新的 CLI：

```bash
python -m coding_agent daemon     # 替代 systemd + agent-poll.sh
python -m coding_agent poll       # 替代手动 agent-poll.sh
python -m coding_agent setup      # 替代 setup.sh
python -m coding_agent status     # 替代 tmux ls
python -m coding_agent attach 42  # 替代 tmux attach
python -m coding_agent logs 42    # 替代 session-log.sh
python -m coding_agent cleanup 42 # 替代 cleanup-issue.sh
python -m coding_agent seed       # 替代 seed-state.sh
```

迁移指南见 `AGENTS.md`。
