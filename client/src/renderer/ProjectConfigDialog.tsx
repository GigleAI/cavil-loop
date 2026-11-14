// Settings → 本机 daemon → a project's "配置" (GitHub#388): a form for the
// everyday settings of that project, instead of handing the config file to a
// text editor.
//
// Which settings exist, their types, labels and current values all come from
// the daemon's own script through the back end (shared/daemon.ts); this file
// only draws them. A row is an input only when the daemon says the setting is
// editable; everything else is shown with the reason. "保存" sends the changed
// settings with the fingerprint of the file as it was read: when the file is
// another one by then nothing is written and the dialog says so. What the
// result means is decided by `saveKind` — a result the client does not know is
// never shown as "saved", and never as "nothing written".
//
// The same form opens for a project of a paired remote machine (GitHub#530): `remote` then says which
// machine and how to read / save there — that machine runs its own project-config.sh, so what may be
// changed and the fingerprint rule are the same. Its file cannot be handed to an editor on this computer.

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon } from './Icons';
import { useLayer, useShortcuts } from './keyboard';
import { keyText } from './shortcuts';
import { copyText } from './pasteImage';
import {
  canEdit,
  configGroups,
  draftChanges,
  fieldProblem,
  installCommand,
  saveKind,
  saveWord,
  valueText,
  type ConfigField,
  type ConfigRead,
  type ConfigSave,
  type DaemonProject,
  type LocalStatus,
  type ProjectConfig,
} from '../shared/daemon';

type Phase =
  | { at: 'loading' }
  /** `old`: a remote machine whose daemon cannot read or change settings from here yet (GitHub#530) */
  | { at: 'failed'; text: string; old?: boolean }
  | { at: 'form'; config: ProjectConfig }
  | { at: 'saving'; config: ProjectConfig }
  | { at: 'done'; config: ProjectConfig; sent: Record<string, string>; result: ConfigSave };

/** A project of a paired remote machine (GitHub#530). */
export interface RemoteConfig {
  /** the machine's name as the remote list shows it */
  name: string;
  read: () => Promise<ConfigRead>;
  save: (rev: string, values: Record<string, string>) => Promise<ConfigSave>;
}

export function ProjectConfigDialog({
  project,
  status,
  remote,
  onClose,
  onOpenEditor,
  onUnsupported,
  onSaved,
}: {
  project: DaemonProject;
  /** the daemon's status as last read: after a save it says whether the chosen agent's program is there */
  status: LocalStatus | null;
  /** a project of a paired remote machine; absent = this computer's daemon */
  remote?: RemoteConfig;
  onClose: () => void;
  /** this computer only: hand the config file to the system's editor */
  onOpenEditor?: () => void;
  /** this computer only — a daemon without the config script: the caller opens the editor instead, with these words */
  onUnsupported?: (why: string) => void;
  /** a save went through: the caller reads the daemon's status again */
  onSaved: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ at: 'loading' });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [kept, setKept] = useState(false);
  const alive = useRef(true);
  const box = useRef<HTMLDivElement>(null);

  const load = async (keep?: Record<string, string>) => {
    setPhase({ at: 'loading' });
    try {
      const r = remote ? await remote.read() : await api().daemonConfigGet(project.key);
      if (!alive.current) return;
      if (r.result === 'unsupported' && !remote && onUnsupported) return onUnsupported(r.output ?? '');
      if (r.result !== 'ok' || !r.config) return setPhase({ at: 'failed', text: r.output || r.result, old: r.result === 'unsupported' });
      setDraft(keep ?? {});
      setPhase({ at: 'form', config: r.config });
    } catch (e) {
      if (alive.current) setPhase({ at: 'failed', text: (e as Error).message });
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    box.current?.focus();
    return () => {
      alive.current = false;
    };
    // one read when the dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const config = phase.at === 'form' || phase.at === 'saving' || phase.at === 'done' ? phase.config : null;
  const changes = config ? draftChanges(config.fields, draft) : {};
  const changed = Object.keys(changes).length;
  const problems = config ? config.fields.filter((f) => f.name in changes && fieldProblem(f, changes[f.name]) !== null).length : 0;
  const saving = phase.at === 'saving';
  const canSave = phase.at === 'form' && changed > 0 && problems === 0;

  const save = async () => {
    if (phase.at !== 'form' || !canSave) return;
    const { config: c } = phase;
    const sent = changes;
    setPhase({ at: 'saving', config: c });
    let result: ConfigSave;
    try {
      result = remote ? await remote.save(c.rev, sent) : await api().daemonConfigSet(c.key, c.rev, sent);
    } catch (e) {
      // the request itself failed: whether the script ran is not known
      result = { result: 'unconfirmed', output: (e as Error).message };
    }
    if (!alive.current) return;
    setPhase({ at: 'done', config: c, sent, result });
    if (saveKind(result.result) !== 'not_written' && saveKind(result.result) !== 'conflict') onSaved();
  };

  const dirty = phase.at === 'form' && changed > 0;
  const close = () => {
    if (!saving) onClose();
  };
  useLayer('dialog');
  useShortcuts({
    confirm: () => void save(),
    cancel: () => {
      if (saving) return;
      if (dirty) return setKept(true);
      onClose();
    },
  });

  return (
    <div className="modal-back" data-testid="config-dialog" data-phase={phase.at} data-remote={remote ? 'true' : 'false'} onClick={dirty ? undefined : close}>
      <div
        className="modal pcfg"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={box}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && (e.target as HTMLElement).tagName === 'BUTTON') e.preventDefault();
        }}
      >
        <div className="pcfg-head">
          <h3>
            项目配置：{project.key}
            {remote && (
              <span className="muted pcfg-where" data-testid="config-remote">
                （在远程机器 {remote.name} 上）
              </span>
            )}
          </h3>
          <div className="muted small">
            {project.repo ?? '仓库读不出'} · 配置文件{remote ? `（在 ${remote.name} 上）` : ''} <code data-testid="config-path">{config?.config ?? project.config ?? '—'}</code>
          </div>
          {(phase.at === 'form' || phase.at === 'saving') && (
            <div className="muted small pcfg-intro" data-testid="config-intro">
              这里列出日常会调的设置。保存后 daemon 在下一轮轮询（约 1 分钟内）按新值工作；已经在跑的 worker 不受影响，下次派工才用新值。
              <br />
              {remote ? '保存时不要同时在那台机器上用编辑器改这个文件' : '保存时不要同时在编辑器里改这个文件'}：两边同时改，其中一边的修改可能丢失。
            </div>
          )}
        </div>

        {phase.at === 'loading' && (
          <div className="pcfg-body">
            <p className="muted small" data-testid="config-loading">
              正在读取配置…
            </p>
          </div>
        )}

        {phase.at === 'failed' && (
          <div className="pcfg-body">
            {phase.old ? (
              <div className="banner warn" data-testid="config-unsupported">
                <div className="banner-text">{phase.text}</div>
              </div>
            ) : (
              <div className="banner error" data-testid="config-read-failed">
                <div className="banner-text">
                  <b>读不出这个项目的配置</b>，所以这里不显示任何值（读不出不等于没设置）。
                  <pre className="daemon-output small">{phase.text}</pre>
                </div>
              </div>
            )}
          </div>
        )}

        {(phase.at === 'form' || phase.at === 'saving') && config && (
          <div className="pcfg-body">
          {/* the scrolling box is the div: a fieldset does not clip its content */}
          <fieldset className="pcfg-form" disabled={saving}>
            {configGroups(config.fields).map((g) => (
              <div key={g.title} data-testid="config-group" data-title={g.title}>
                <div className="pcfg-group">{g.title}</div>
                {g.fields.some((f) => f.mode === 'show') && (
                  <div className="muted small pcfg-note">下面这些会让 daemon 多做一类事（自动合并、谁开 issue 都派工……）或需要在仓库里新建标签，这里只显示现在的值；{remote ? '要改请到那台机器上用编辑器改。' : '要改请用编辑器。'}</div>
                )}
                {g.fields.map((f) => (
                  <Row key={f.name} f={f} draft={draft[f.name]} onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))} onOpenEditor={remote ? undefined : onOpenEditor} />
                ))}
              </div>
            ))}
            <div className="muted small pcfg-note">其余设置（目录、命令、钩子、令牌等）不在这里显示。</div>
          </fieldset>
          </div>
        )}

        {phase.at === 'done' && <Done phase={phase} project={project} status={status} remote={remote?.name} />}

        {kept && dirty && (
          <div className="small warn-text pcfg-kept" data-testid="dialog-esc-hint">
            有没保存的修改，按 Esc 不会丢掉；点「取消」才会丢掉。
          </div>
        )}
        <div className="pcfg-foot">
          {remote || !onOpenEditor ? (
            <span className="muted small" data-testid="config-no-editor">
              远程机器上的文件没法在这台电脑用编辑器打开
            </span>
          ) : (
            <button className="ghost" data-testid="config-open-editor" disabled={saving} onClick={onOpenEditor}>
              用编辑器打开配置文件
            </button>
          )}
          <span className="grow" />
          {phase.at === 'form' && changed > 0 && problems === 0 && (
            <span className="small pcfg-pending" data-testid="config-pending">
              已改 {changed} 项，还没保存
            </span>
          )}
          {phase.at === 'form' && problems > 0 && (
            <span className="small err" data-testid="config-problems">
              有 {problems} 项填得不对，改好才能保存
            </span>
          )}
          {(phase.at === 'form' || phase.at === 'saving') && (
            <>
              <button data-testid="config-cancel" disabled={saving} onClick={onClose} title="取消（Esc）">
                取消
              </button>
              <button className="primary" data-testid="config-save" disabled={!canSave} onClick={() => void save()} title={`保存（${keyText('confirm')}）`}>
                {saving ? '正在保存…' : '保存'}
              </button>
            </>
          )}
          {(phase.at === 'loading' || phase.at === 'failed') && (
            <>
              {phase.at === 'failed' && (
                <button data-testid="config-reload" onClick={() => void load()}>
                  重新读取
                </button>
              )}
              <button data-testid="config-cancel" onClick={onClose}>
                关闭
              </button>
            </>
          )}
          {phase.at === 'done' &&
            (saveKind(phase.result.result) === 'saved' || saveKind(phase.result.result) === 'unchanged' ? (
              <>
                <button data-testid="config-more" onClick={() => void load()}>
                  继续改
                </button>
                <button className="primary" data-testid="config-close" onClick={onClose}>
                  完成
                </button>
              </>
            ) : (
              <>
                <button data-testid="config-cancel" onClick={onClose}>
                  取消
                </button>
                {/* a conflict keeps what was typed: after the re-read the same changes are in the form again */}
                <button className="primary" data-testid="config-reload" onClick={() => void load(saveKind(phase.result.result) === 'conflict' ? phase.sent : undefined)}>
                  重新读取
                </button>
              </>
            ))}
        </div>
      </div>
    </div>
  );
}

function Row({ f, draft, onChange, onOpenEditor }: { f: ConfigField; draft: string | undefined; onChange: (v: string) => void; onOpenEditor?: () => void }) {
  const editable = canEdit(f);
  const value = draft ?? f.value;
  const changed = editable && value !== f.value;
  const problem = changed ? fieldProblem(f, value) : null;
  return (
    <div className={`pcfg-row${problem ? ' bad' : changed ? ' changed' : ''}`} data-testid="config-row" data-name={f.name} data-editable={String(editable)} data-changed={String(changed)} data-bad={String(!!problem)}>
      <div className="what">
        <b>{f.label}</b>
        <div className="muted small">
          {!f.in_file && f.mode === 'edit' && (
            <span className="pcfg-pill" data-testid="config-absent" title="配置文件里没有这一行，daemon 按右边的值工作；在这里保存后会把这一行写进配置文件">
              配置文件里没写这一项
            </span>
          )}
          {f.help}
        </div>
      </div>
      <div className="ctl">
        {editable ? (
          <Control f={f} value={value} onChange={onChange} />
        ) : (
          <div className="pcfg-ro" data-testid="config-readonly">
            {valueText(f, f.value)}
          </div>
        )}
        {changed && !problem && (
          <span className="pcfg-was" data-testid="config-was">
            原来：{valueText(f, f.value)}
          </span>
        )}
        {problem && (
          <span className="err small" data-testid="config-problem">
            {problem}
          </span>
        )}
        {!editable && f.mode === 'edit' && (
          <span className="muted small" data-testid="config-why">
            {f.editable ? '这个客户端还不认识这种设置，这里不改它。' : `${f.reason ?? '这一项现在不能在这里改'}，这里不改它。`}
            {onOpenEditor ? (
              <button className="link" onClick={onOpenEditor}>
                用编辑器打开
              </button>
            ) : (
              '要改请到那台机器上用编辑器改。'
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function Control({ f, value, onChange }: { f: ConfigField; value: string; onChange: (v: string) => void }) {
  const id = `config-input-${f.name}`;
  if (f.type === 'agent' || f.type === 'enum') {
    return (
      <select data-testid={id} aria-label={f.label} value={value} onChange={(e) => onChange(e.target.value)}>
        {(f.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label && o.label !== o.value ? `${o.label}（${o.value}）` : o.value}
          </option>
        ))}
      </select>
    );
  }
  if (f.type === 'bool') {
    const on = value === f.on;
    return (
      <button type="button" role="switch" aria-checked={on} aria-label={f.label} className={`pcfg-switch${on ? ' on' : ''}`} data-testid={id} data-on={String(on)} onClick={() => onChange(on ? (f.off ?? '') : (f.on ?? ''))}>
        <i />
        {on ? '开' : '关'}
      </button>
    );
  }
  if (f.type === 'int') {
    return (
      <span className="pcfg-num">
        <input className="n" data-testid={id} aria-label={f.label} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.trim())} />
        <span className="muted small">
          （{f.min}–{f.max}）
        </span>
      </span>
    );
  }
  return <input className="t" data-testid={id} aria-label={f.label} value={value} placeholder="留空" spellCheck={false} onChange={(e) => onChange(e.target.value.trim())} />;
}

function Done({ phase, project, status, remote }: { phase: Extract<Phase, { at: 'done' }>; project: DaemonProject; status: LocalStatus | null; remote?: string }) {
  const { result, config, sent } = phase;
  const kind = saveKind(result.result);
  const label = (name: string) => config.fields.find((f) => f.name === name);
  const text = (name: string, v: string) => {
    const f = label(name);
    return f ? valueText(f, v) : v;
  };
  const changes = result.detail?.changes ?? [];
  const backup = result.detail?.backup;
  // what the daemon's status says now about this project's programs (read again after the save)
  const now = status?.projects.find((p) => p.key === project.key);
  const missing = now?.deps.state === 'missing' ? (now.deps.missing ?? []) : [];
  return (
    <div className="pcfg-body" data-testid="config-result" data-result={result.result} data-kind={kind}>
      {kind === 'saved' && (
        <div className="banner ok">
          <span className="icon">
            <Icon name="check" />
          </span>
          <div className="banner-text">
            <b>已保存 {changes.length} 项</b>，下一轮轮询（约 1 分钟内）生效。保存前的配置文件已备份。
          </div>
        </div>
      )}
      {kind === 'unchanged' && (
        <div className="banner info">
          <div className="banner-text">配置文件里已经是这些值，什么都没写。</div>
        </div>
      )}
      {(kind === 'conflict' || kind === 'not_written') && (
        <div className="banner error">
          <span className="icon">
            <Icon name="warn" />
          </span>
          <div className="banner-text">
            <b>没有保存，配置文件一个字都没动。</b>
            <br />
            {saveWord(result.result)}
            {kind === 'not_written' && result.output && <pre className="daemon-output small err">{result.output}</pre>}
          </div>
        </div>
      )}
      {kind === 'rewritten' && (
        <div className="banner warn">
          <span className="icon">
            <Icon name="warn" />
          </span>
          <div className="banner-text">
            <b>已写入，但随后又被别处改了。</b>
            <br />
            新值换上之后，配置文件马上又被别处改写（比如编辑器存了一次），现在的内容不是刚保存的。客户端没有再动它。点「重新读取」看现在的值；保存前的版本在下面的备份里。
          </div>
        </div>
      )}
      {kind === 'unknown' && (
        <div className="banner warn">
          <span className="icon">
            <Icon name="warn" />
          </span>
          <div className="banner-text">
            <b>保存没有给出最终结果。</b>
            <br />
            配置文件可能已经改了，也可能没改。点「重新读取」核对现在的值。
            {result.output && <pre className="daemon-output small">{result.output}</pre>}
          </div>
        </div>
      )}

      {kind === 'saved' && changes.length > 0 && (
        <table className="pcfg-changes" data-testid="config-changes">
          <thead>
            <tr>
              <th>设置</th>
              <th>原来</th>
              <th>现在</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.name} data-testid="config-change" data-name={c.name}>
                <td>{c.label || c.name}</td>
                <td>{text(c.name, c.old)}</td>
                <td>
                  <b>{text(c.name, c.new)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {kind !== 'saved' && kind !== 'unchanged' && Object.keys(sent).length > 0 && (
        <div className="muted small" data-testid="config-sent">
          刚才要改的 {Object.keys(sent).length} 项：
          {Object.entries(sent)
            .map(([n, v]) => `${label(n)?.label ?? n} → ${text(n, v)}`)
            .join('；')}
        </div>
      )}
      {kind === 'saved' && missing.length > 0 && (
        <div className="banner warn" data-testid="config-missing">
          <div className="banner-text">
            {remote ? (
              <>
                <b>
                  {remote} 上还没装 {missing.join('、')}
                </b>
                ：下次派工会失败。在那台机器上装好后，在这里点「重新读取」。
              </>
            ) : (
              <>
                <b>这台电脑还没装 {missing.join('、')}</b>：下次派工会失败。装好后在「本机 daemon」里点「重新检查」。
              </>
            )}
            {missing.map((m) => {
              const cmd = installCommand(m, status?.os ?? '');
              return cmd ? <Command key={m} text={cmd} /> : null;
            })}
          </div>
        </div>
      )}
      {backup && (kind === 'saved' || kind === 'rewritten') && (
        <div className="muted small">
          备份：<code data-testid="config-backup">{backup}</code>
        </div>
      )}
    </div>
  );
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="daemon-command">
      <code data-testid="daemon-command">{text}</code>
      <button className="ghost small" data-testid="daemon-copy" onClick={async () => setCopied(await copyText(text))}>
        {copied === null ? '复制' : copied ? '已复制' : '复制失败，请手动选中'}
      </button>
    </div>
  );
}
