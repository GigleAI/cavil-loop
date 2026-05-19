from __future__ import annotations

import json
import os
import platform
import subprocess
import time
import urllib.error
import urllib.request

from coding_agent.log_util import log
from coding_agent.worker import SessionInfo, WorkerBase, WorkerStatus, register_worker

_STATUS_MAP = {
    "working": WorkerStatus.WORKING,
    "idle": WorkerStatus.IDLE,
    "needs_input": WorkerStatus.NEEDS_INPUT,
    "completed": WorkerStatus.COMPLETED,
    "failed": WorkerStatus.FAILED,
    "stopped": WorkerStatus.STOPPED,
}


@register_worker
class OpencodeWorker(WorkerBase):
    def __init__(self, base_url: str = "http://127.0.0.1:4096") -> None:
        self.base_url = base_url
        self._port = int(base_url.rsplit(":", 1)[-1])
        self._server_proc: subprocess.Popen | None = None

    @property
    def name(self) -> str:
        return "opencode"

    def _ensure_server(self) -> None:
        try:
            resp = urllib.request.urlopen(
                urllib.request.Request(self.base_url + "/global/health"),
                timeout=5,
            )
            if resp.status == 200:
                return
        except Exception:
            pass

        log("opencode serve not running, starting it")
        popen_kwargs: dict = {
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if platform.system() == "Windows":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["start_new_session"] = True
        self._server_proc = subprocess.Popen(
            [
                "opencode",
                "serve",
                "--port",
                str(self._port),
                "--hostname",
                "127.0.0.1",
            ],
            **popen_kwargs,
        )

        for _ in range(5):
            time.sleep(1)
            try:
                resp = urllib.request.urlopen(
                    urllib.request.Request(self.base_url + "/global/health"),
                    timeout=5,
                )
                if resp.status == 200:
                    log("opencode serve is healthy")
                    return
            except Exception:
                continue

        raise RuntimeError("opencode serve did not become healthy within 5 seconds")

    def _request(
        self, method: str, path: str, json_data: dict | None = None, timeout: int = 30
    ) -> dict | list | None:
        url = self.base_url + path
        body = None
        if json_data is not None and method in ("POST", "PATCH", "PUT"):
            body = json.dumps(json_data).encode("utf-8")
        req = urllib.request.Request(url, data=body, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            raw = resp.read()
            if not raw:
                return None
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            log(f"HTTP error {e.code} for {method} {path}: {e.reason}")
            return None
        except Exception as e:
            log(f"Request failed for {method} {path}: {e}")
            return None

    def start(
        self,
        session_name: str,
        worktree: str,
        prompt: str,
        env: dict[str, str] | None = None,
        extra_flags: list[str] | None = None,
    ) -> SessionInfo:
        self._ensure_server()
        result = self._request("POST", "/session", json_data={"title": session_name})
        if result is None:
            log(f"Failed to create session {session_name}")
            return SessionInfo(
                id="",
                name=session_name,
                status=WorkerStatus.FAILED,
                worktree=worktree,
                worker=self.name,
            )
        session_id = result.get("id", "")
        self._request(
            "POST",
            f"/session/{session_id}/message",
            json_data={
                "parts": [{"type": "text", "text": prompt}],
                "noReply": False,
            },
        )
        return SessionInfo(
            id=session_id,
            name=session_name,
            status=WorkerStatus.WORKING,
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
        self._ensure_server()
        existing = self._request("GET", f"/session/{session_id}")
        if existing is None:
            log(f"Session {session_id} not found for resume")
            return SessionInfo(
                id=session_id,
                name=session_id,
                status=WorkerStatus.NOT_FOUND,
                worktree=worktree,
                worker=self.name,
            )
        self._request(
            "POST",
            f"/session/{session_id}/message",
            json_data={"parts": [{"type": "text", "text": prompt}]},
        )
        return SessionInfo(
            id=session_id,
            name=session_id,
            status=WorkerStatus.WORKING,
            worktree=worktree,
            worker=self.name,
        )

    def get_status(self, session_id: str) -> WorkerStatus:
        self._ensure_server()
        result = self._request("GET", "/session/status")
        if result is None or not isinstance(result, dict):
            return WorkerStatus.NOT_FOUND
        entry = result.get(session_id)
        if entry is None:
            return WorkerStatus.NOT_FOUND
        if isinstance(entry, dict):
            status_str = entry.get("status", "")
        else:
            status_str = str(entry)
        return _STATUS_MAP.get(status_str, WorkerStatus.NOT_FOUND)

    def list_sessions(self) -> list[SessionInfo]:
        self._ensure_server()
        result = self._request("GET", "/session")
        if result is None or not isinstance(result, list):
            return []
        sessions = []
        for s in result:
            status_str = s.get("status", "idle")
            sessions.append(
                SessionInfo(
                    id=s.get("id", ""),
                    name=s.get("title", s.get("id", "")),
                    status=_STATUS_MAP.get(status_str, WorkerStatus.IDLE),
                    worktree=s.get("cwd", s.get("worktree", "")),
                    worker=self.name,
                )
            )
        return sessions

    def stop(self, session_id: str) -> None:
        self._ensure_server()
        result = self._request("POST", f"/session/{session_id}/abort")
        if result is not None:
            log(f"opencode abort session {session_id} succeeded")
        else:
            log(f"opencode abort session {session_id} failed")

    def get_logs(self, session_id: str) -> str:
        self._ensure_server()
        result = self._request("GET", f"/session/{session_id}/message")
        if result is None or not isinstance(result, list):
            return ""
        lines = []
        for msg in result:
            for part in msg.get("parts", []):
                if part.get("type") == "text":
                    lines.append(part.get("text", ""))
        return "\n".join(lines)

    def has_history(self, worktree: str) -> bool:
        self._ensure_server()
        result = self._request("GET", "/session")
        if result is None or not isinstance(result, list):
            return False
        for s in result:
            if s.get("cwd", s.get("worktree", "")) == worktree:
                return True
        return False

    def attach(self, session_id: str) -> None:
        os.execvp(
            "opencode",
            ["opencode", "attach", self.base_url, "--session", session_id],
        )

    def cleanup(self, session_id: str) -> None:
        self._ensure_server()
        self._request("DELETE", f"/session/{session_id}")
        log(f"opencode cleanup deleted session {session_id}")
