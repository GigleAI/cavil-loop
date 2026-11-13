import type { SourceConfig } from './types';
import { t } from './i18n';

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/**
 * Parse what a user pastes into "add source":
 *   https://github.com/orgs/<org>/projects/<n>[/views/<v>]
 *   https://github.com/users/<user>/projects/<n>[/...]
 *   <owner>/<repo>  or  https://github.com/<owner>/<repo>[/...]
 * Returns null when it is neither.
 */
export function parseSource(input: string): SourceConfig | null {
  const raw = input.trim();
  if (!raw) return null;
  let path = raw;
  const m = raw.match(/^https?:\/\/(?:www\.)?github\.com\/(.*)$/i);
  if (m) path = m[1];
  else if (/^[a-z]+:\/\//i.test(raw)) return null;
  path = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);

  if ((parts[0] === 'orgs' || parts[0] === 'users') && parts[2] === 'projects' && /^\d+$/.test(parts[3] ?? '')) {
    const owner = parts[1];
    if (!NAME.test(owner)) return null;
    const ownerType = parts[0] === 'orgs' ? 'org' : 'user';
    const number = Number(parts[3]);
    const view = parts[4] === 'views' && /^\d+$/.test(parts[5] ?? '') ? Number(parts[5]) : undefined;
    return {
      kind: 'project',
      key: `project:${ownerType}/${owner.toLowerCase()}/${number}`,
      ownerType,
      owner,
      number,
      url: `https://github.com/${parts[0]}/${owner}/projects/${number}`,
      ...(view !== undefined ? { view } : {}),
    };
  }
  if (!m && parts.length !== 2) return null;
  if (parts.length >= 2 && !['orgs', 'users'].includes(parts[0])) {
    const [owner, name] = parts;
    if (!NAME.test(owner) || !NAME.test(name)) return null;
    return { kind: 'repo', key: `repo:${owner.toLowerCase()}/${name.toLowerCase()}`, owner, name };
  }
  return null;
}

export function sourceLabel(s: SourceConfig, projectTitle?: string): string {
  if (s.kind === 'repo') return `${s.owner}/${s.name}`;
  return projectTitle ? t('{title}（{owner} #{number}）', { title: projectTitle, owner: s.owner, number: s.number }) : `${s.owner} Project #${s.number}`;
}

export function itemKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}
