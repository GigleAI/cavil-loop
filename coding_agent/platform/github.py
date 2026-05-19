import json
import subprocess

from coding_agent.log_util import log
from coding_agent.platform import PlatformBase, register_platform


@register_platform
class GitHubPlatform(PlatformBase):
    @property
    def name(self) -> str:
        return "github"

    @property
    def cli_cmd(self) -> str:
        return "gh"

    def _run_gh(self, desc: str, *args: str, repo: str = "") -> subprocess.CompletedProcess:
        cmd = ["gh"]
        if repo:
            cmd += ["--repo", repo]
        cmd += list(args)
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            log(f"\u26a0\ufe0f {desc}\u5931\u8d25: {result.stderr.strip()}")
        return result

    def list_issues(self, repo: str, label: str) -> list[dict]:
        result = self._run_gh(
            "list issues",
            "issue", "list",
            "--state", "open",
            "--label", label,
            "--json", "number,title",
            "--jq", ".[]",
            repo=repo,
        )
        if result.returncode != 0:
            return []
        items = []
        for line in result.stdout.strip().splitlines():
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
                items.append({"number": int(obj["number"]), "title": str(obj["title"])})
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
        return items

    def list_prs(self, repo: str, label: str) -> list[dict]:
        result = self._run_gh(
            "list PRs",
            "pr", "list",
            "--label", label,
            "--json", "number,headRefName",
            "--jq", ".[]",
            repo=repo,
        )
        if result.returncode != 0:
            return []
        items = []
        for line in result.stdout.strip().splitlines():
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
                items.append({"number": int(obj["number"]), "headRefName": str(obj["headRefName"])})
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
        return items

    def list_merged_prs(self, repo: str, limit: int = 30) -> list[dict]:
        result = self._run_gh(
            "list merged PRs",
            "pr", "list",
            "--state", "merged",
            "--limit", str(limit),
            "--json", "number,headRefName",
            repo=repo,
        )
        if result.returncode != 0:
            return []
        try:
            data = json.loads(result.stdout)
            return [{"number": int(obj["number"]), "headRefName": str(obj["headRefName"])} for obj in data]
        except (json.JSONDecodeError, KeyError, ValueError):
            return []

    def edit_labels(
        self,
        target: str,
        target_type: str,
        repo: str,
        add_labels: list[str],
        remove_labels: list[str],
    ) -> bool:
        cmd_parts = [target_type, "edit", target]
        for lbl in add_labels:
            cmd_parts += ["--add-label", lbl]
        for lbl in remove_labels:
            cmd_parts += ["--remove-label", lbl]
        result = self._run_gh("edit labels", *cmd_parts, repo=repo)
        return result.returncode == 0

    def create_label(self, name: str, color: str, description: str, repo: str) -> bool:
        result = self._run_gh(
            "create label",
            "label", "create", name,
            "--color", color,
            "--description", description,
            repo=repo,
        )
        return result.returncode == 0

    def get_issue_title(self, issue_num: int, repo: str) -> str:
        result = self._run_gh(
            "get issue title",
            "issue", "view", str(issue_num),
            "--json", "title",
            "--jq", ".title",
            repo=repo,
        )
        if result.returncode != 0:
            return ""
        return result.stdout.strip()

    def get_issue_state(self, issue_num: int, repo: str) -> str:
        result = self._run_gh(
            "get issue state",
            "issue", "view", str(issue_num),
            "--json", "state",
            "--jq", ".state",
            repo=repo,
        )
        if result.returncode != 0:
            return "OPEN"
        return result.stdout.strip() or "OPEN"

    def get_latest_comment_id(self, repo: str, issue_or_pr: str, endpoint: str) -> int:
        endpoint_paths = {
            "issues": "issues",
            "pulls_comments": "pulls",
            "pulls_reviews": "pulls",
            "issues_comments": "issues",
        }
        api_segment = endpoint_paths.get(endpoint, "issues")
        if endpoint == "pulls_comments":
            api_path = f"repos/{repo}/{api_segment}/{issue_or_pr}/comments"
        elif endpoint == "pulls_reviews":
            api_path = f"repos/{repo}/{api_segment}/{issue_or_pr}/reviews"
        else:
            api_path = f"repos/{repo}/{api_segment}/{issue_or_pr}/comments"
        result = self._run_gh(
            "get latest comment id",
            "api", api_path,
            "--jq", ".[-1].id // 0",
        )
        if result.returncode != 0:
            return 0
        try:
            return int(result.stdout.strip())
        except ValueError:
            return 0

    def comment_on_issue(self, issue_num: int, repo: str, body: str) -> bool:
        result = self._run_gh(
            "comment on issue",
            "issue", "comment", str(issue_num),
            "--body", body,
            repo=repo,
        )
        return result.returncode == 0

    def comment_on_pr(self, pr_num: int, repo: str, body: str) -> bool:
        result = self._run_gh(
            "comment on PR",
            "pr", "comment", str(pr_num),
            "--body", body,
            repo=repo,
        )
        return result.returncode == 0

    def get_repo_name(self, host_path: str) -> str:
        result = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
            capture_output=True,
            text=True,
            cwd=host_path,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        return "owner/repo"

    def auth_status(self) -> bool:
        result = subprocess.run(
            ["gh", "auth", "status"],
            capture_output=True,
            text=True,
        )
        return result.returncode == 0