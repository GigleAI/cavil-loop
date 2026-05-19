from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from coding_agent.log_util import log
from coding_agent.worker import SessionInfo, WorkerBase, WorkerStatus, register_worker


@register_worker
class ClaudeWorker(WorkerBase):
    @property
    def name(self) -> str:
        return "claude"

    def _jobs_dir(self) -> Path:
        return Path.home() / ".claude" / "jobs"

    def _encode_cwd(self, worktree: str) -> str:
        return os.path.abspath(worktree).replace("/", "-").replace("\\", "-")

    def _build_env(self, env: dict[str, str] | None = None) -> dict[str, str] | None:
        if env is None:
            return None
        merged = os.environ.copy()
        merged.update(env)
        return merged

    def start(
        self,
        session_name: str,
        worktree: str,
        prompt: str,
        env: dict[str, str] | None = None,
        extra_flags: list[str] | None = None,
    ) -> SessionInfo:
        flags = list(extra_flags) if extra_flags else []
        bg_args = ["claude", "--bg", "--name", session_name, *flags, prompt]
        run_env = self._build_env(env)
        try:
            result = subprocess.run(
                bg_args,
                cwd=worktree,
                capture_output=True,
                text=True,
                env=run_env,
                timeout=30,
            )
            output = result.stdout.strip()
            match = re.search(r"·\s*([0-9a-fA-F]+)", output)
            if match:
                session_id = match.group(1)
                log(f"claude --bg started session {session_id}")
                return SessionInfo(
                    id=session_id,
                    name=session_name,
                    status=WorkerStatus.WORKING,
                    worktree=worktree,
                    worker=self.name,
                )
            log(f"claude --bg failed: could not parse session id from output: {output}")
        except FileNotFoundError:
            log("claude CLI not found")
        except subprocess.TimeoutExpired:
            log("claude --bg timed out")
        except Exception as exc:
            log(f"claude --bg error: {exc}")
        return SessionInfo(
            id="",
            name=session_name,
            status=WorkerStatus.FAILED,
            worktree=worktree,
            worker=self.name,
        )

    def resume(
        self,
        session_id: str,
        worktree: str,
        prompt: str,
        extra_flags: list[str] | None = None,
    ) -> SessionInfo:
        flags = list(extra_flags) if extra_flags else []
        current_status = self.get_status(session_id)
        if current_status == WorkerStatus.NOT_FOUND:
            args = ["claude", "--continue", "-p", prompt, *flags]
            log(f"claude resume: session {session_id} not found, using --continue")
        else:
            args = ["claude", "-r", session_id, "-p", prompt, *flags]
            log(f"claude resume session {session_id} via -r flag")
        env = os.environ.copy()
        proc = subprocess.Popen(
            args,
            cwd=worktree,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            start_new_session=True,
        )
        log(f"claude resume detached (pid={proc.pid})")
        return SessionInfo(
            id=session_id,
            name=session_id,
            status=WorkerStatus.WORKING,
            worktree=worktree,
            worker=self.name,
        )

    def _status_from_state(self, state: dict) -> WorkerStatus:
        raw = state.get("status", "").lower()
        mapping = {
            "working": WorkerStatus.WORKING,
            "idle": WorkerStatus.IDLE,
            "needs_input": WorkerStatus.NEEDS_INPUT,
            "completed": WorkerStatus.COMPLETED,
            "failed": WorkerStatus.FAILED,
            "stopped": WorkerStatus.STOPPED,
        }
        return mapping.get(raw, WorkerStatus.WORKING)

    def get_status(self, session_id: str) -> WorkerStatus:
        state_path = self._jobs_dir() / session_id / "state.json"
        if not state_path.is_file():
            return WorkerStatus.NOT_FOUND
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            if "status" in data:
                return self._status_from_state(data)
        except (json.JSONDecodeError, OSError) as exc:
            log(f"error reading state.json for {session_id}: {exc}")
        return WorkerStatus.NOT_FOUND

    def list_sessions(self) -> list[SessionInfo]:
        jobs_dir = self._jobs_dir()
        if not jobs_dir.is_dir():
            return []
        sessions: list[SessionInfo] = []
        for entry in jobs_dir.iterdir():
            if entry.is_dir():
                state_path = entry / "state.json"
                if state_path.is_file():
                    try:
                        data = json.loads(state_path.read_text(encoding="utf-8"))
                        status = self._status_from_state(data) if "status" in data else WorkerStatus.WORKING
                        sessions.append(
                            SessionInfo(
                                id=entry.name,
                                name=data.get("name", entry.name),
                                status=status,
                                worktree=data.get("cwd", ""),
                                worker=self.name,
                            )
                        )
                    except (json.JSONDecodeError, OSError):
                        continue
        return sessions

    def stop(self, session_id: str) -> None:
        try:
            result = subprocess.run(
                ["claude", "stop", session_id],
                capture_output=True,
                text=True,
                timeout=10,
            )
            log(f"claude stop {session_id}: rc={result.returncode}")
        except Exception as exc:
            log(f"claude stop {session_id} failed: {exc}")

    def get_logs(self, session_id: str) -> str:
        try:
            result = subprocess.run(
                ["claude", "logs", session_id],
                capture_output=True,
                text=True,
                timeout=30,
            )
            return result.stdout
        except Exception as exc:
            log(f"claude logs {session_id} failed: {exc}")
            return ""

    def has_history(self, worktree: str) -> bool:
        encoded = self._encode_cwd(worktree)
        proj_dir = Path.home() / ".claude" / "projects" / encoded
        if not proj_dir.is_dir():
            return False
        return bool(list(proj_dir.glob("*.jsonl")))

    def attach(self, session_id: str) -> None:
        os.execvp("claude", ["claude", "attach", session_id])

    def cleanup(self, session_id: str) -> None:
        pass