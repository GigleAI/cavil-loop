import shutil
import subprocess
from pathlib import Path

from coding_agent.log_util import log


def show_ref(project_root: str, ref: str) -> bool:
    result = subprocess.run(
        ["git", "-C", project_root, "show-ref", "--verify", "--quiet", ref],
        capture_output=True,
    )
    return result.returncode == 0


def fetch_origin(project_root: str, branch: str) -> bool:
    result = subprocess.run(
        ["git", "-C", project_root, "fetch", "origin", branch],
        capture_output=True,
    )
    if result.returncode != 0:
        log(f"fetch origin {branch} failed: {result.stderr.decode().strip()}")
        return False
    log(f"fetched origin/{branch}")
    return True


def create_branch(project_root: str, branch: str, base: str = "main") -> bool:
    if show_ref(project_root, f"refs/heads/{branch}"):
        log(f"branch already exists: {branch}")
        return True
    if show_ref(project_root, f"refs/remotes/origin/{branch}"):
        log(f"branch exists on origin, fetching: {branch}")
        if not fetch_origin(project_root, branch):
            return False
        return True
    result = subprocess.run(
        ["git", "-C", project_root, "branch", branch, base],
        capture_output=True,
    )
    if result.returncode != 0:
        log(f"create branch failed: {result.stderr.decode().strip()}")
        return False
    log(f"created branch {branch} from {base}")
    return True


def create_worktree(
    project_root: str, worktree_dir: str, branch: str, worktree_base: str
) -> str:
    if Path(worktree_dir).exists():
        log(f"worktree already exists: {worktree_dir}")
        return worktree_dir
    Path(worktree_base).mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "-C", project_root, "worktree", "add", worktree_dir, branch],
        capture_output=True,
    )
    if result.returncode != 0:
        log(f"worktree add failed: {result.stderr.decode().strip()}")
        return ""
    log(f"created worktree {worktree_dir} on {branch}")
    return worktree_dir


def remove_worktree(project_root: str, worktree_dir: str, force: bool = False) -> bool:
    cmd = ["git", "-C", project_root, "worktree", "remove", worktree_dir]
    if force:
        cmd.append("--force")
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        log(f"worktree remove failed: {result.stderr.decode().strip()}")
        return False
    subprocess.run(["git", "-C", project_root, "worktree", "prune"], capture_output=True)
    log(f"removed worktree {worktree_dir}")
    return True


def set_worktree_identity(
    worktree_dir: str, name: str = "", email: str = ""
) -> None:
    if name:
        subprocess.run(
            ["git", "-C", worktree_dir, "config", "user.name", name],
            capture_output=True,
        )
    if email:
        subprocess.run(
            ["git", "-C", worktree_dir, "config", "user.email", email],
            capture_output=True,
        )
    r_name = subprocess.run(
        ["git", "-C", worktree_dir, "config", "user.name"],
        capture_output=True,
        text=True,
    )
    r_email = subprocess.run(
        ["git", "-C", worktree_dir, "config", "user.email"],
        capture_output=True,
        text=True,
    )
    log(
        f"worktree identity: {r_name.stdout.strip()} <{r_email.stdout.strip()}>"
    )


def copy_files_to_worktree(
    project_root: str, worktree_dir: str, files: str
) -> None:
    if not files.strip():
        return
    for rel in files.strip().split():
        src = Path(project_root) / rel
        dst = Path(worktree_dir) / rel
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(src), str(dst))
            log(f"copied {rel} to worktree")


def run_setup_cmd(worktree_dir: str, cmd: str) -> bool:
    if not cmd.strip() or cmd.strip() == ":":
        return True
    result = subprocess.run(cmd, cwd=worktree_dir, shell=True, capture_output=True)
    if result.returncode != 0:
        log(f"WORKTREE_SETUP_CMD failed: {result.stderr.decode().strip()}")
        return False
    log(f"WORKTREE_SETUP_CMD succeeded: {cmd}")
    return True


def delete_branch(project_root: str, branch: str) -> bool:
    result = subprocess.run(
        ["git", "-C", project_root, "branch", "-D", branch],
        capture_output=True,
    )
    if result.returncode != 0:
        log(f"delete branch failed: {result.stderr.decode().strip()}")
        return False
    log(f"deleted branch {branch}")
    return True
