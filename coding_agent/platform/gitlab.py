import json
import subprocess

from coding_agent.log_util import log
from coding_agent.platform import PlatformBase, register_platform


@register_platform
class GitLabPlatform(PlatformBase):
    @property
    def name(self) -> str:
        return "gitlab"

    @property
    def cli_cmd(self) -> str:
        return "glab"

    def _run_glab(self, desc: str, *args: str, repo: str = "") -> subprocess.CompletedProcess:
        cmd = ["glab"]
        if repo:
            cmd += ["--repo", repo]
        cmd += list(args)
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            log(f"\u26a0\ufe0f {desc} failed: {result.stderr.strip()}")
        return result

    def list_issues(self, repo: str, label: str) -> list[dict]:
        result = self._run_glab(
            "list issues",
            "issue", "list",
            "--label", label,
            "--output", "json",
            repo=repo,
        )
        if result.returncode != 0:
            return []
        try:
            data = json.loads(result.stdout)
            if isinstance(data, list):
                raw = data
            elif isinstance(data, dict):
                raw = data.get("issues", data.get("data", []))
            else:
                return []
            items = []
            for obj in raw:
                try:
                    num = int(obj.get("iid", obj.get("number", 0)))
                    title = str(obj.get("title", ""))
                    items.append({"number": num, "title": title})
                except (KeyError, ValueError):
                    continue
            return items
        except (json.JSONDecodeError, ValueError):
            return []

    def list_prs(self, repo: str, label: str) -> list[dict]:
        result = self._run_glab(
            "list MRs",
            "mr", "list",
            "--label", label,
            "--output", "json",
            repo=repo,
        )
        if result.returncode != 0:
            return []
        try:
            data = json.loads(result.stdout)
            if isinstance(data, list):
                raw = data
            elif isinstance(data, dict):
                raw = data.get("merge_requests", data.get("data", []))
            else:
                return []
            items = []
            for obj in raw:
                try:
                    num = int(obj.get("iid", obj.get("number", 0)))
                    branch = str(obj.get("source_branch", obj.get("headRefName", "")))
                    items.append({"number": num, "headRefName": branch})
                except (KeyError, ValueError):
                    continue
            return items
        except (json.JSONDecodeError, ValueError):
            return []

    def list_merged_prs(self, repo: str, limit: int = 30) -> list[dict]:
        result = self._run_glab(
            "list merged MRs",
            "mr", "list",
            "--state", "merged",
            "--output", "json",
            repo=repo,
        )
        if result.returncode != 0:
            return []
        try:
            data = json.loads(result.stdout)
            if isinstance(data, list):
                raw = data
            elif isinstance(data, dict):
                raw = data.get("merge_requests", data.get("data", []))
            else:
                return []
            items = []
            for obj in raw:
                try:
                    num = int(obj.get("iid", obj.get("number", 0)))
                    branch = str(obj.get("source_branch", obj.get("headRefName", "")))
                    items.append({"number": num, "headRefName": branch})
                except (KeyError, ValueError):
                    continue
            return items
        except (json.JSONDecodeError, ValueError):
            return []

    def edit_labels(
        self,
        target: str,
        target_type: str,
        repo: str,
        add_labels: list[str],
        remove_labels: list[str],
    ) -> bool:
        if target_type == "issue":
            cmd_parts = ["issue", "update", target]
        elif target_type == "pr":
            cmd_parts = ["mr", "update", target]
        else:
            cmd_parts = [target_type, "update", target]
        if add_labels:
            cmd_parts += ["--add-label", ",".join(add_labels)]
        if remove_labels:
            cmd_parts += ["--remove-label", ",".join(remove_labels)]
        result = self._run_glab("edit labels", *cmd_parts, repo=repo)
        return result.returncode == 0

    def create_label(self, name: str, color: str, description: str, repo: str) -> bool:
        result = self._run_glab(
            "create label",
            "label", "create",
            "--name", name,
            "--color", color,
            "--description", description,
            repo=repo,
        )
        return result.returncode == 0

    def get_issue_title(self, issue_num: int, repo: str) -> str:
        result = self._run_glab(
            "get issue title",
            "issue", "view", str(issue_num),
            "--output", "json",
            repo=repo,
        )
        if result.returncode != 0:
            return ""
        try:
            data = json.loads(result.stdout)
            if isinstance(data, dict):
                return str(data.get("title", ""))
            return ""
        except (json.JSONDecodeError, ValueError):
            return ""

    def get_issue_state(self, issue_num: int, repo: str) -> str:
        result = self._run_glab(
            "get issue state",
            "issue", "view", str(issue_num),
            "--output", "json",
            repo=repo,
        )
        if result.returncode != 0:
            return "OPEN"
        try:
            data = json.loads(result.stdout)
            if isinstance(data, dict):
                state = data.get("state", "opened")
                if state == "closed":
                    return "CLOSED"
            return "OPEN"
        except (json.JSONDecodeError, ValueError):
            return "OPEN"

    def get_latest_comment_id(self, repo: str, issue_or_pr: str, endpoint: str) -> int:
        encoded_repo = repo.replace("/", "%2F")
        if endpoint in ("issues", "issues_comments"):
            api_path = f"projects/{encoded_repo}/issues/{issue_or_pr}/notes"
        elif endpoint in ("pulls_comments", "pulls_reviews"):
            api_path = f"projects/{encoded_repo}/merge_requests/{issue_or_pr}/notes"
        else:
            api_path = f"projects/{encoded_repo}/issues/{issue_or_pr}/notes"
        result = self._run_glab(
            "get latest note id",
            "api", api_path,
            repo=repo,
        )
        if result.returncode != 0:
            return 0
        try:
            data = json.loads(result.stdout)
            if isinstance(data, list) and data:
                return int(data[-1].get("id", 0))
            return 0
        except (json.JSONDecodeError, ValueError, KeyError):
            return 0

    def comment_on_issue(self, issue_num: int, repo: str, body: str) -> bool:
        result = self._run_glab(
            "comment on issue",
            "issue", "note", str(issue_num),
            "--message", body,
            repo=repo,
        )
        return result.returncode == 0

    def comment_on_pr(self, pr_num: int, repo: str, body: str) -> bool:
        result = self._run_glab(
            "comment on MR",
            "mr", "note", str(pr_num),
            "--message", body,
            repo=repo,
        )
        return result.returncode == 0

    def get_repo_name(self, host_path: str) -> str:
        result = subprocess.run(
            ["glab", "repo", "view", "--output", "json"],
            capture_output=True,
            text=True,
            cwd=host_path,
        )
        if result.returncode == 0 and result.stdout.strip():
            try:
                data = json.loads(result.stdout)
                if isinstance(data, dict):
                    name = data.get("path_with_namespace", "")
                    if name:
                        return name
            except (json.JSONDecodeError, ValueError):
                pass
        return "owner/repo"

    def auth_status(self) -> bool:
        result = subprocess.run(
            ["glab", "auth", "status"],
            capture_output=True,
            text=True,
        )
        return result.returncode == 0