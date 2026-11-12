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

/**
 * A daemon from before the status script (GitHub#320), as the back end judged it on its own: a git checkout
 * (can be updated from here), a managed release, a plain folder, or not known (`error` says why).
 */
export type Outdated =
  | { form: 'checkout' | 'managed' | 'directory'; target: string }
  | { form: 'unknown'; error: string };

export type DaemonStatus =
  | { state: 'missing'; entry: string }
  /** `precheck`: the status script could check only the common tools (no jq) — those are still listed */
  | { state: 'unreadable'; reason: string; entry: string | null; precheck?: Precheck; outdated?: Outdated }
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
  /** `still_old`: pulled, but what the checkout follows still has no status script (GitHub#320) */
  result: 'updated' | 'current' | 'blocked' | 'managed' | 'refused' | 'still_old';
  step?: string;
  branch?: string;
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
      // the script reports it only after reading back both the file and the job (launchd-refresh.sh)
      failed: '没换成，已恢复原样（原文件和任务状态都读回确认过）',
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

// ── "接上 daemon" from the repository list (GitHub#315) ──

export interface ConnectInfo extends DaemonResult {
  result: 'ok' | 'refused';
  repo?: string;
  /** the daemon's own agents (scripts/drivers), its default first */
  agents?: string[];
  /** projects already connected for this repository */
  connected?: { key: string; host: string | null; state: SchedState }[];
  /** local copies found (git repositories whose origin is this repository) */
  candidates?: string[];
  /** where a clone goes by default (~/github when there is one) */
  clone_parent?: string;
}

export interface Precheck2 extends DaemonResult {
  result: 'ok' | 'unreadable' | 'refused';
  agent?: string;
  ready?: boolean;
  missing?: string[];
  gh_logged_in?: boolean | null;
  os?: string;
}

export interface DirCheck extends DaemonResult {
  result: 'ok' | 'refused';
  dir?: string;
  /** a project config already in the folder: setup.sh keeps it, and its agent (null: not readable) */
  config?: { path: string; agent: string | null } | null;
}

export interface ConnectOutcome {
  result: 'connected' | 'failed' | 'blocked';
  output: string;
  key?: string;
  state?: SchedState;
  already?: boolean;
  dir?: string;
}

export interface ConnectPoll extends DaemonResult {
  output?: string;
  next?: number;
  done?: boolean;
  outcome?: ConnectOutcome | null;
}

/** The precheck as checklist rows: each missing program with a command, and gh's sign-in. */
export function precheckRows(p: Precheck2): CheckRow[] {
  if (p.result !== 'ok') return [{ id: 'unreadable', ok: null, text: `读不到本机缺什么：${p.output ?? p.result}`, command: null }];
  const os = p.os ?? '';
  const rows: CheckRow[] = (p.missing ?? []).map((m) => ({ id: `tool:${m}`, ok: false, text: `缺 ${m}`, command: installCommand(m, os) }));
  if (rows.length === 0) rows.push({ id: 'tools', ok: true, text: `${p.agent} 需要的程序都在`, command: null });
  if (p.gh_logged_in === false) rows.push({ id: 'gh', ok: false, text: 'gh 没有登录：daemon 要用 gh 自己的登录读写 GitHub', command: 'gh auth login' });
  return rows;
}

/** Projects the status script lists for one repository (`owner/name`, any case). */
export function projectsFor(st: LocalStatus, repo: string): DaemonProject[] {
  const r = repo.toLowerCase();
  return st.projects.filter((p) => (p.repo ?? '').toLowerCase() === r);
}

// ── "配置" on a project (GitHub#388) ──
// What can be read and changed is decided by the daemon (scripts/config-fields.txt, read through
// scripts/project-config.sh); the client draws the form from it and checks typed values the same
// way, so a wrong value is marked before anything is sent. The script checks everything again.

export interface ConfigField {
  name: string;
  group: string;
  /** "show": listed, never changed here */
  mode: 'edit' | 'show';
  label: string;
  help: string;
  /** agent | model | int | bool | enum | label — one this client does not know is shown only */
  type: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  on?: string;
  off?: string;
  value: string;
  default: string;
  /** false: the config file has no such line; `value` is what the daemon uses then */
  in_file: boolean;
  editable: boolean;
  reason: string | null;
}

export interface ProjectConfig {
  version: 1;
  key: string;
  state: 'ok';
  config: string;
  real: string;
  /** fingerprint of the file as read; a save names it and is refused when the file is another one by then */
  rev: string;
  fields: ConfigField[];
}

export interface ConfigRead extends DaemonResult {
  /** `unsupported`: a daemon from before the config script — the editor is the only way */
  result: 'ok' | 'unsupported' | 'unreadable' | 'not_found' | 'refused';
  config?: ProjectConfig;
}

export interface ConfigChange {
  name: string;
  label: string;
  old: string;
  new: string;
  added: boolean;
}

export interface ConfigSave extends DaemonResult {
  detail?: { changes?: ConfigChange[]; backup?: string; config?: string; field?: string; reason?: string };
}

const KNOWN_TYPES = new Set(['agent', 'model', 'int', 'bool', 'enum']);
/** what project-config.sh may write on one config line (its LIT_CHARS) */
const PLAIN = /^[A-Za-z0-9._:/@,+-]*$/;

/** A field the form lets the person change: the daemon says editable, and this client knows the type. */
export const canEdit = (f: ConfigField) => f.mode === 'edit' && f.editable && KNOWN_TYPES.has(f.type);

/** Why `v` cannot be saved into `f`; null when it can. */
export function fieldProblem(f: ConfigField, v: string): string | null {
  if (!PLAIN.test(v)) return '不能有空格、引号、$ 这类字符';
  switch (f.type) {
    case 'int': {
      const lo = f.min ?? 0;
      const hi = f.max ?? 999_999_999;
      return /^(0|[1-9]\d{0,8})$/.test(v) && Number(v) >= lo && Number(v) <= hi ? null : `只能是 ${lo} 到 ${hi} 之间的整数`;
    }
    case 'model':
      return v === '' || (v.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(v)) ? null : '模型名只能含字母、数字和 . _ : / @ -';
    case 'agent':
    case 'enum':
      return (f.options ?? []).some((o) => o.value === v) ? null : '不在可选的值里';
    case 'bool':
      return v === f.on || v === f.off ? null : `只能是 ${f.on} 或 ${f.off}`;
    default:
      return '这一项不能在这里改';
  }
}

/** A value as the person reads it (read-only rows, "原来：…", the list of what was saved). */
export function valueText(f: ConfigField, v: string): string {
  if (f.type === 'label') return v === '' ? '关' : `开，标签 ${v}`;
  if (f.type === 'bool') return v === f.on ? '开' : v === f.off ? '关' : v;
  if (f.type === 'enum') {
    const o = (f.options ?? []).find((x) => x.value === v);
    return o && o.label && o.label !== v ? `${o.label}（${v}）` : v;
  }
  return v === '' ? '（空）' : v;
}

/** Fields by group, in the daemon's order. */
export function configGroups(fields: ConfigField[]): { title: string; fields: ConfigField[] }[] {
  const out: { title: string; fields: ConfigField[] }[] = [];
  for (const f of fields) {
    const g = out.find((x) => x.title === f.group);
    if (g) g.fields.push(f);
    else out.push({ title: f.group, fields: [f] });
  }
  return out;
}

/** What a save would send: editable fields whose typed value differs from the one read. */
export function draftChanges(fields: ConfigField[], draft: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = draft[f.name];
    if (v !== undefined && canEdit(f) && v !== f.value) out[f.name] = v;
  }
  return out;
}

/** results of a save after which the config file is exactly as it was */
const NOT_WRITTEN = new Set(['changed', 'invalid', 'not_editable', 'busy', 'unreadable', 'verify_failed', 'backup_failed', 'write_failed', 'not_found', 'refused']);

export type SaveKind = 'saved' | 'unchanged' | 'conflict' | 'not_written' | 'rewritten' | 'unknown';

/** What a save's result word means for the person. Anything unheard of is "unknown", never "saved". */
export function saveKind(result: string): SaveKind {
  if (result === 'saved') return 'saved';
  if (result === 'unchanged') return 'unchanged';
  if (result === 'changed') return 'conflict';
  if (result === 'saved_then_changed') return 'rewritten';
  return NOT_WRITTEN.has(result) ? 'not_written' : 'unknown';
}

export function saveWord(result: string): string {
  return (
    {
      changed: '打开这个弹窗之后，配置文件被别处改过（比如在编辑器里）。重新读取后再改一次。',
      invalid: '有一项的值不合规。',
      not_editable: '有一项现在不能在这里改（配置文件里它的写法变了）。重新读取后再看。',
      busy: '另一个保存还没结束，稍后再试。',
      unreadable: '配置文件现在加载不了。',
      verify_failed: '新文件没通过检查：改完之后配置加载出来的结果对不上。这份配置请用编辑器改。',
      backup_failed: '保存前的备份写不进去，所以没有保存。',
      write_failed: '写不了配置文件所在的目录。',
      not_found: '本机已经没有接入这个项目。',
      refused: '后台没有执行这次保存。',
    } as Record<string, string>
  )[result] ?? '';
}
