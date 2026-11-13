// The local cavil-loop daemon as the settings page shows it (GitHub#314).
// Every fact comes from the daemon's own status script (GitHub#313), run by the
// back end (src-tauri/crates/core/src/daemon.rs); this file only words it.
// The one thing the client adds is a copyable install command per missing
// program — it never decides on its own which programs are needed.

import { getLang, t, translate, zhKey, type Params, type VerbatimSource } from './i18n';
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
  | { form: 'unknown'; error: string; errorSaid?: unknown };

export type DaemonStatus =
  | { state: 'missing'; entry: string }
  /** `precheck`: the status script could check only the common tools (no jq) — those are still listed */
  | { state: 'unreadable'; reason: string; reasonSaid?: unknown; entry: string | null; precheck?: Precheck; outdated?: Outdated }
  | { state: 'ok'; entry: string; status: LocalStatus };

/** `refused`: the back end did not run anything (the reason is `output`) */
export interface DaemonResult {
  result: string;
  output?: string;
  /** GitHub#473: `output` with its outside parts marked (the back end's Said); absent: shown as `output` */
  outputSaid?: unknown;
  state?: SchedState;
  code?: number | null;
  path?: string;
}

export interface DaemonRefresh {
  key: string | null;
  result: string;
  code: number | null;
  output: string;
  outputSaid?: unknown;
}

export interface DaemonUpdate extends DaemonResult {
  /** `still_old`: pulled, but what the checkout follows still has no status script (GitHub#320) */
  result: 'updated' | 'current' | 'blocked' | 'managed' | 'refused' | 'still_old';
  step?: string;
  branch?: string;
  branchSaid?: unknown;
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

/**
 * GitHub#473: a sentence of the client's own words with holes, some filled with text from outside
 * (a program's name the status script reported, a path on this machine). `wordsText` reads it as one
 * string; the window draws it with the outside parts marked (renderer/WordsText.tsx).
 */
export interface Words {
  zh: string;
  params?: Params;
  /** which params are outside text, and where they come from */
  outside?: Readonly<Record<string, VerbatimSource>>;
}

export const wordsText = (w: Words): string => translate(getLang(), w.zh, w.params);

export interface CheckRow {
  id: string;
  ok: boolean | null;
  text: string;
  words: Words;
  command: string | null;
}

const row = (id: string, ok: boolean | null, words: Words, command: string | null): CheckRow => ({ id, ok, text: wordsText(words), words, command });

/** "缺 tmux" — the program's name as the status script gave it */
const missingWords = (m: string): Words => ({ zh: zhKey('缺 {name}'), params: { name: m }, outside: { name: 'daemon' } });

/** One row per common tool the status script found missing (or one "齐全" row). */
export function toolRows(missing: string[], os: string): CheckRow[] {
  if (missing.length === 0) return [row('tools', true, { zh: zhKey('通用工具齐全') }, null)];
  return missing.map((m) => row(`tool:${m}`, false, missingWords(m), installCommand(m, os)));
}

/** The checklist: what the status script found missing, gh's sign-in, the poller's bash. */
export function checklist(st: LocalStatus): CheckRow[] {
  const rows: CheckRow[] = toolRows(st.base_deps.missing, st.os);
  if (st.gh.installed) {
    if (st.gh.logged_in) rows.push(row('gh', true, { zh: zhKey('gh 已登录（daemon 用它读写 GitHub）') }, null));
    else rows.push(row('gh', false, { zh: zhKey('gh 没有登录：daemon 要用 gh 自己的登录读写 GitHub（客户端的登录不交给它）') }, 'gh auth login'));
  }
  if (st.bash) {
    if (st.bash.ok === false) {
      rows.push(
        row(
          'bash',
          false,
          { zh: zhKey('轮询会用的 bash（{path}）是 {major} 版，太旧，daemon 跑不起来'), params: { path: st.bash.path, major: String(st.bash.major) }, outside: { path: 'daemon' } },
          st.os === 'Darwin' ? 'brew install bash' : null,
        ),
      );
    } else if (st.bash.ok === null) {
      rows.push(row('bash', null, { zh: zhKey('读不出轮询会用的 bash（{path}）的版本'), params: { path: st.bash.path }, outside: { path: 'daemon' } }, null));
    }
  }
  return rows;
}

export function schedWord(s: SchedState | undefined): string {
  return s === 'running' ? t('在跑') : s === 'stopped' ? t('已停') : t('读不到');
}

/** launchd-refresh.sh's RESULT words (GitHub#313) */
export function refreshWord(r: string): string {
  switch (r) {
    case 'replaced':
      return t('已换新');
    case 'unchanged':
      return t('无需换新');
    case 'unknown':
      return t('读不到后台任务状态，什么都没动');
    case 'lint_failed':
      return t('新配置文件校验不过，什么都没动');
    case 'lock_timeout':
      return t('等不到这一轮轮询结束，什么都没动');
    case 'not_found':
      return t('找不到这个项目的后台任务配置');
    case 'not_macos':
      return t('不是 macOS，不需要');
    // the script reports it only after reading back both the file and the job (launchd-refresh.sh)
    case 'failed':
      return t('没换成，已恢复原样（原文件和任务状态都读回确认过）');
    case 'needs_human':
      return t('没换成，恢复也失败：需要人处理');
    // no final result from the script (killed, timed out, stopped half-way): nothing is confirmed
    case 'unconfirmed':
      return t('脚本中途退出，没有最终结果：配置文件和后台任务可能已经改动、没有确认恢复，需要人处理');
    default:
      return t('没换成（{r}）', { r });
  }
}

export const refreshOk = (r: string) => r === 'replaced' || r === 'unchanged';

/** "3 分钟前" */
export function ago(epochSec: number, nowMs: number): string {
  const mins = Math.floor((nowMs / 1000 - epochSec) / 60);
  if (mins < 1) return t('不到 1 分钟前');
  if (mins < 60) return t('{n} 分钟前', { n: mins });
  const h = Math.floor(mins / 60);
  if (h < 48) return t('{n} 小时前', { n: h });
  return t('{n} 天前', { n: Math.floor(h / 24) });
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
  outputSaid?: unknown;
  key?: string;
  state?: SchedState;
  already?: boolean;
  dir?: string;
}

/** a stretch of the connect output: the client's own words (`from` null) or text from outside */
export interface ConnectPiece {
  text: string;
  from: VerbatimSource | null;
}

export interface ConnectPoll extends DaemonResult {
  output?: string;
  /** GitHub#473: the same text as `output`, in stretches marked with who wrote them */
  pieces?: ConnectPiece[];
  next?: number;
  done?: boolean;
  outcome?: ConnectOutcome | null;
}

/** The precheck as checklist rows: each missing program with a command, and gh's sign-in. */
export function precheckRows(p: Precheck2): CheckRow[] {
  // the reason is the back end's (its words in the window's language, outside parts in `outputSaid`)
  if (p.result !== 'ok') return [row('unreadable', null, { zh: zhKey('读不到本机缺什么：{why}'), params: { why: p.output ?? p.result } }, null)];
  const os = p.os ?? '';
  const rows: CheckRow[] = (p.missing ?? []).map((m) => row(`tool:${m}`, false, missingWords(m), installCommand(m, os)));
  if (rows.length === 0) rows.push(row('tools', true, { zh: zhKey('{agent} 需要的程序都在'), params: { agent: p.agent ?? '' } }, null));
  if (p.gh_logged_in === false) rows.push(row('gh', false, { zh: zhKey('gh 没有登录：daemon 要用 gh 自己的登录读写 GitHub') }, 'gh auth login'));
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
  if (!PLAIN.test(v)) return t('不能有空格、引号、$ 这类字符');
  switch (f.type) {
    case 'int': {
      const lo = f.min ?? 0;
      const hi = f.max ?? 999_999_999;
      return /^(0|[1-9]\d{0,8})$/.test(v) && Number(v) >= lo && Number(v) <= hi ? null : t('只能是 {lo} 到 {hi} 之间的整数', { lo: String(lo), hi: String(hi) });
    }
    case 'model':
      return v === '' || (v.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(v)) ? null : t('模型名只能含字母、数字和 . _ : / @ -');
    case 'agent':
    case 'enum':
      return (f.options ?? []).some((o) => o.value === v) ? null : t('不在可选的值里');
    case 'bool':
      return v === f.on || v === f.off ? null : t('只能是 {on} 或 {off}', { on: String(f.on), off: String(f.off) });
    default:
      return t('这一项不能在这里改');
  }
}

/**
 * A value as the person reads it (read-only rows, "原来：…", the list of what was saved). The value
 * and an option's label are the daemon's (the config and scripts/config-fields.txt): outside text.
 */
export function valueWords(f: ConfigField, v: string): Words {
  const as = (x: string): Words => ({ zh: '{v}', params: { v: x }, outside: { v: 'daemon' } });
  if (f.type === 'label') return v === '' ? { zh: zhKey('关') } : { zh: zhKey('开，标签 {v}'), params: { v }, outside: { v: 'daemon' } };
  if (f.type === 'bool') return v === f.on ? { zh: zhKey('开') } : v === f.off ? { zh: zhKey('关') } : as(v);
  if (f.type === 'enum') {
    const o = (f.options ?? []).find((x) => x.value === v);
    return o && o.label && o.label !== v ? { zh: zhKey('{label}（{v}）'), params: { label: o.label, v }, outside: { label: 'daemon', v: 'daemon' } } : as(v);
  }
  return v === '' ? { zh: zhKey('（空）') } : as(v);
}

export const valueText = (f: ConfigField, v: string): string => wordsText(valueWords(f, v));

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
  switch (result) {
    case 'changed':
      return t('打开这个弹窗之后，配置文件被别处改过（比如在编辑器里）。重新读取后再改一次。');
    case 'invalid':
      return t('有一项的值不合规。');
    case 'not_editable':
      return t('有一项现在不能在这里改（配置文件里它的写法变了）。重新读取后再看。');
    case 'busy':
      return t('另一个保存还没结束，稍后再试。');
    case 'unreadable':
      return t('配置文件现在加载不了。');
    case 'verify_failed':
      return t('新文件没通过检查：改完之后配置加载出来的结果对不上。这份配置请用编辑器改。');
    case 'backup_failed':
      return t('保存前的备份写不进去，所以没有保存。');
    case 'write_failed':
      return t('写不了配置文件所在的目录。');
    case 'not_found':
      return t('本机已经没有接入这个项目。');
    case 'refused':
      return t('后台没有执行这次保存。');
    default:
      return '';
  }
}
