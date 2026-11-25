// The hand-over between the Client workflow and the Mac that signs (scripts/handover.mjs): which draft
// the Mac builds, and which ones the nightly run reports as waiting too long.
import { describe, expect, it } from 'vitest';
import { channelOf, handedOver, stale, waiting } from '../../scripts/handover.mjs';
import { devFiles, windowsFiles } from '../../scripts/dev-release.mjs';

const SHA = 'a'.repeat(40);
const asset = (name: string) => ({ name, state: 'uploaded', size: 10 });
let id = 1;
/** a draft handed to the Mac: never public, on a full commit, both Windows files uploaded */
const draft = (v: string, over: Record<string, unknown> = {}) => ({
  id: id++,
  tag_name: `client/v${v}`,
  draft: true,
  prerelease: v.includes('-dev.'),
  published_at: null,
  target_commitish: SHA,
  created_at: '2026-11-25T10:00:00Z',
  assets: windowsFiles(v).map(asset),
  ...over,
});
const pub = (v: string) => ({ id: id++, tag_name: `client/v${v}`, draft: false, prerelease: v.includes('-dev.'), published_at: '2026-11-24T00:00:00Z', target_commitish: SHA, assets: devFiles(v).map(asset) });

describe('the hand-over to the Mac', () => {
  it('channels by version shape', () => {
    expect(channelOf('0.5.3-dev.683')).toBe('dev');
    expect(channelOf('0.5.3')).toBe('stable');
    for (const v of ['0.5', '0.5.3-rc.1', 'v0.5.3', '', '2026.11.01.1']) expect(channelOf(v), v).toBeNull();
  });

  it('a handed-over draft: never public, a full commit, both Windows files uploaded — anything else is not', () => {
    expect(handedOver([draft('0.5.3-dev.683')]).map((d) => d.tag)).toEqual(['client/v0.5.3-dev.683']);
    const not = [
      ['public', pub('0.5.3-dev.1')],
      ['was public once', draft('0.5.3-dev.2', { published_at: '2026-11-24T00:00:00Z' })],
      ['publish time unreadable', draft('0.5.3-dev.3', { published_at: undefined })],
      ['a branch name, not a commit', draft('0.5.3-dev.4', { target_commitish: 'main' })],
      ['Windows signature missing', draft('0.5.3-dev.5', { assets: [asset(windowsFiles('0.5.3-dev.5')[0])] })],
      ['Windows upload unfinished', draft('0.5.3-dev.6', { assets: windowsFiles('0.5.3-dev.6').map((n) => ({ name: n, state: 'starter', size: 0 })) })],
      ['not a client tag', draft('0.5.3-dev.7', { tag_name: 'release/v2026.11.01.1' })],
      ['not a version', draft('0.5.3-dev.8', { tag_name: 'client/vnext' })],
    ] as const;
    for (const [why, r] of not) expect(handedOver([r]), why).toEqual([]);
  });

  it('the Mac builds a release before any development build, the lowest release first', () => {
    const list = [draft('0.5.3-dev.690'), draft('0.6.1'), draft('0.6.0')];
    expect(waiting(list)?.tag).toBe('client/v0.6.0');
  });

  it('of the development drafts only the highest, and never one below the highest published build', () => {
    expect(waiting([draft('0.5.3-dev.683'), draft('0.5.3-dev.690'), draft('0.5.3-dev.685')])?.version).toBe('0.5.3-dev.690');
    // a published 691 makes every lower draft stale (dev-release.mjs deletes those)
    expect(waiting([pub('0.5.3-dev.691'), draft('0.5.3-dev.690')])).toBeNull();
    expect(waiting([pub('0.5.3-dev.680'), draft('0.5.3-dev.690')])?.version).toBe('0.5.3-dev.690');
    expect(waiting([])).toBeNull();
  });

  it('what it hands the Mac: the commit and the channel', () => {
    expect(waiting([draft('0.5.3-dev.683')])).toMatchObject({ tag: 'client/v0.5.3-dev.683', version: '0.5.3-dev.683', channel: 'dev', sha: SHA });
    expect(waiting([draft('0.6.0')])).toMatchObject({ channel: 'stable' });
  });

  it('too long: older than the hours given, or a creation time that cannot be read', () => {
    const now = Date.parse('2026-11-25T23:00:00Z');
    const list = [draft('0.5.3-dev.1', { created_at: '2026-11-25T10:00:00Z' }), draft('0.5.3-dev.2', { created_at: '2026-11-25T22:00:00Z' }), draft('0.5.3-dev.3', { created_at: undefined })];
    expect(stale(list, 12, now).map((d) => d.version)).toEqual(['0.5.3-dev.1', '0.5.3-dev.3']);
    expect(stale(list, 14, now).map((d) => d.version)).toEqual(['0.5.3-dev.3']);
  });
});
