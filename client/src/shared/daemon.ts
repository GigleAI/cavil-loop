// The local cavil-loop daemon as the settings page shows it (GitHub#314).
// Every fact comes from the daemon's own status script (GitHub#313), run by the
// back end (src-tauri/crates/core/src/daemon.rs); this file only words it.
// The one thing the client adds is a copyable install command per missing
// program — it never decides on its own which programs are needed.

export type SchedState = 'running' | 'stopped' | 'unknown';

export interface DaemonAgent {
  role: string;
  agent: string;
  bin: string | null;
  state: 'ok' | 'missing' | 'no_driver';
  required: boolean;
  missing: string[];
}

export interface DaemonProject {
  key: string;
  layout: string;
  host: string | null;
  config: string | null;
  config_state: 'ok' | 'unreadable';
  repo: string | null;
  state_dir: string | null;
  agents: DaemonAgent[] | null;
  deps: { state: 'ok' | 'missing' | 'unknown'; missing: string[] | null };
  scheduler: { kind: 'systemd' | 'launchd'; unit: string; state: SchedState; raw?: string } | null;
  last_poll: { epoch: number; iso: string; source: string } | null;
}

export interface LocalStatus {
  version: 1;
  os: string;
  scheduler: 'systemd' | 'launchd' | null;
  daemon: { entry: string; target: string | null; form: 'managed' | 'checkout' | 'directory' | 'missing' | 'dangling' | 'unknown'; version: string | null };
  gh: { installed: boolean; logged_in: boolean | null };
  base_deps: { missing: string[] };
  /** the bash the poller runs with (absent: a status script from before this field) */
  bash?: { path: string; major: number | null; ok: boolean | null };
  projects: DaemonProject[];
}

export interface Precheck {
  os: string;
  base_deps: { missing: string[] };
}

export type DaemonStatus =
  | { state: 'missing'; entry: string }
  /** `precheck`: the status script could check only the common tools (no jq) — those are still listed */
  | { state: 'unreadable'; reason: string; entry: string | null; precheck?: Precheck }
  | { state: 'ok'; entry: string; status: LocalStatus };

/** `refused`: the back end did not run anything (the reason is `output`) */
export interface DaemonResult {
  result: string;
  output?: string;
  state?: SchedState;
  code?: number | null;
  path?: string;
}

export interface DaemonRefresh {
  key: string | null;
  result: string;
  code: number | null;
  output: string;
}

export interface DaemonUpdate extends DaemonResult {
  result: 'updated' | 'current' | 'blocked' | 'managed' | 'refused';
  step?: string;
  before?: string;
  after?: string;
  version?: string | null;
  refresh?: DaemonRefresh[];
}

const AGENT_INSTALL: Record<string, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
};
/** part of the operating system: nothing to install */
const SYSTEM = new Set(['systemctl', 'timeout', 'launchctl']);

/** A command a person can paste into a terminal for one missing program; null when there is none to offer. */
export function installCommand(program: string, os: string): string | null {
  if (AGENT_INSTALL[program]) return AGENT_INSTALL[program];
  if (SYSTEM.has(program) || !/^[a-z0-9][a-z0-9._+-]*$/.test(program)) return null;
  if (os === 'Darwin') return `brew install ${program}`;
  if (os === 'Linux') return `sudo apt-get install -y ${program === 'flock' ? 'util-linux' : program}`;
  return null;
}

export interface CheckRow {
  id: string;
  ok: boolean | null;
  text: string;
  command: string | null;
}

/** One row per common tool the status script found missing (or one "齐全" row). */
export function toolRows(missing: string[], os: string): CheckRow[] {
  if (missing.length === 0) return [{ id: 'tools', ok: true, text: '通用工具齐全', command: null }];
  return missing.map((m) => ({ id: `tool:${m}`, ok: false, text: `缺 ${m}`, command: installCommand(m, os) }));
}

/** The checklist: what the status script found missing, gh's sign-in, the poller's bash. */
export function checklist(st: LocalStatus): CheckRow[] {
  const rows: CheckRow[] = toolRows(st.base_deps.missing, st.os);
  if (st.gh.installed) {
    if (st.gh.logged_in) rows.push({ id: 'gh', ok: true, text: 'gh 已登录（daemon 用它读写 GitHub）', command: null });
    else rows.push({ id: 'gh', ok: false, text: 'gh 没有登录：daemon 要用 gh 自己的登录读写 GitHub（客户端的登录不交给它）', command: 'gh auth login' });
  }
  if (st.bash) {
    if (st.bash.ok === false) {
      rows.push({
        id: 'bash',
        ok: false,
        text: `轮询会用的 bash（${st.bash.path}）是 ${st.bash.major} 版，太旧，daemon 跑不起来`,
        command: st.os === 'Darwin' ? 'brew install bash' : null,
      });
    } else if (st.bash.ok === null) {
      rows.push({ id: 'bash', ok: null, text: `读不出轮询会用的 bash（${st.bash.path}）的版本`, command: null });
    }
  }
  return rows;
}

export function schedWord(s: SchedState | undefined): string {
  return s === 'running' ? '在跑' : s === 'stopped' ? '已停' : '读不到';
}

/** launchd-refresh.sh's RESULT words (GitHub#313) */
export function refreshWord(r: string): string {
  return (
    {
      replaced: '已换新',
      unchanged: '无需换新',
      unknown: '读不到后台任务状态，什么都没动',
      lint_failed: '新配置文件校验不过，什么都没动',
      lock_timeout: '等不到这一轮轮询结束，什么都没动',
      not_found: '找不到这个项目的后台任务配置',
      not_macos: '不是 macOS，不需要',
      failed: '没换成，已恢复原样',
      needs_human: '没换成，恢复也失败：需要人处理',
      // no final result from the script (killed, timed out, stopped half-way): nothing is confirmed
      unconfirmed: '脚本中途退出，没有最终结果：配置文件和后台任务可能已经改动、没有确认恢复，需要人处理',
    } as Record<string, string>
  )[r] ?? `没换成（${r}）`;
}

export const refreshOk = (r: string) => r === 'replaced' || r === 'unchanged';

/** "3 分钟前" */
export function ago(epochSec: number, nowMs: number): string {
  const mins = Math.floor((nowMs / 1000 - epochSec) / 60);
  if (mins < 1) return '不到 1 分钟前';
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** what the window may ask; the back end checks every argument again */
export const KEY_RE = /^[A-Za-z0-9_.-]+$/;
