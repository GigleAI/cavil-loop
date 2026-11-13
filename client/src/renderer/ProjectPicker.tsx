// GitHub#401: "从 GitHub 选" — the Projects the signed-in account can see, its own first, then each
// organisation's; one click adds one. An organisation that could not be read says why (the same
// words as everywhere else), never "no Projects". Pasting an address stays: an organisation that has
// not approved this app may be missing from GitHub's list altogether.

import { useEffect, useState } from 'react';
import type { AppState, ProjectChoices } from '../shared/types';
import { parseSource } from '../shared/sources';
import { api } from './api';
import { Icon } from './Icons';
import { FailureNote, openAuthPage, useWaiting } from './FailureNote';
import { choicesWaitUntil } from '../shared/readFailure';
import { t } from '../shared/i18n';
import { Verbatim } from './Verbatim';
import { tNode } from './tNode';

export function ProjectPicker({ state }: { state: AppState }) {
  const [res, setRes] = useState<ProjectChoices | null>(null);
  const [seq, setSeq] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setRes(null);
    api()
      .projectChoices()
      .then((r) => alive && setRes(r));
    return () => {
      alive = false;
    };
  }, [seq]);
  // PR #414 review round 1: a rate limit holds every way of reading this list again, this button too
  const waiting = useWaiting(res ? choicesWaitUntil(res) : null);
  const reload = () => {
    if (!waiting) setSeq((n) => n + 1);
  };
  const added = new Set(state.sources.map((s) => s.key));
  const add = async (url: string) => {
    const r = await api().addSource(url);
    setError(r.ok ? null : (r.error ?? t('添加失败')));
  };
  return (
    <div className="pp" data-testid="project-picker">
      <div className="pp-head">
        {t('这个账号能看到的 Project')}
        <span className="spacer" />
        <button className="ghost" data-testid="picker-reload" onClick={reload} disabled={res === null || waiting}>
          <Icon name="refresh" />
          {t('重新读取')}
        </button>
      </div>
      {res === null && <div className="pp-empty muted" data-testid="picker-loading">{t('正在读取…')}</div>}
      {res && !res.ok && res.failure && (
        <div className="pp-pad">
          <FailureNote failure={res.failure} state={state} onRetry={reload} testid="picker-failure" />
        </div>
      )}
      {res?.ok &&
        res.groups.map((g) => (
          <div key={`${g.ownerType}/${g.owner}`} className="pp-group" data-testid="picker-group" data-owner={g.owner}>
            <div className="pp-grp">
              {g.ownerType === 'user' ? tNode('{owner}（个人）', { owner: <Verbatim from="github">{g.owner}</Verbatim> }) : tNode('{owner}（组织）', { owner: <Verbatim from="github">{g.owner}</Verbatim> })}
            </div>
            {!g.ok && g.failure && (
              <div className="pp-pad">
                <FailureNote failure={g.failure} state={state} onRetry={reload}  testid="picker-group-failure" />
              </div>
            )}
            {g.ok && g.projects.length === 0 && <div className="pp-empty muted">{t('没有开着的 Project')}</div>}
            {g.projects.map((p) => {
              const key = parseSource(p.url)?.key;
              return (
                <div key={p.url} className="pp-row" data-testid="picker-row" data-url={p.url}>
                  <Icon name="project" />
                  <span className="t">
                    <Verbatim from="github">{p.title}</Verbatim> <span className="n">#{p.number}</span>
                  </span>
                  {key && added.has(key) ? (
                    <span className="muted small" data-testid="picker-added">
                      <Icon name="check" size={14} /> {t('已添加')}
                    </span>
                  ) : (
                    <button data-testid="picker-add" onClick={() => void add(p.url)}>
                      {t('添加')}
                    </button>
                  )}
                </div>
              );
            })}
            {g.truncated && <div className="pp-empty muted">{t('只列出了前面一部分；没看到的请贴网址添加')}</div>}
          </div>
        ))}
      {res?.ok && res.orgsFailure && (
        <div className="pp-group" data-testid="picker-orgs-failure">
          <div className="pp-grp">{t('所在组织')}</div>
          <div className="pp-pad">
            <FailureNote failure={res.orgsFailure} state={state} onRetry={reload} testid="picker-orgs-note" />
          </div>
        </div>
      )}
      {res?.ok && res.orgsTruncated && <div className="pp-empty muted">{t('所在组织太多，只列出了前面一部分；没看到的请贴网址添加')}</div>}
      {error && (
        <div className="banner error" data-testid="picker-error">
          <Icon name="warn" />
          <span className="banner-text">{error}</span>
        </div>
      )}
      <div className="pp-foot">
        <span className="muted small">{t('没看到要找的组织？组织没批准 Cavil Loop 时，GitHub 可能连组织名都不返回——到授权页的「Organization access」里申请或批准，再回来重新读取；也可以直接在上面贴 Project 的网址。')}</span>
        <button data-testid="picker-auth-page" onClick={openAuthPage}>
          {t('打开 GitHub 授权页')}
        </button>
      </div>
    </div>
  );
}
