// How the settings page words the daemon's status (GitHub#314): the checklist
// only lists what the status script found, and offers a command per missing program.

import { describe, expect, it } from 'vitest';
import { checklist, installCommand, refreshWord, type LocalStatus } from '../../src/shared/daemon';

const base = (o: Partial<LocalStatus> = {}): LocalStatus => ({
  version: 1,
  os: 'Darwin',
  scheduler: 'launchd',
  daemon: { entry: '/h/.agents/skills/cavil-loop', target: '/h/.agents/skills/cavil-loop', form: 'checkout', version: 'abc' },
  gh: { installed: true, logged_in: true },
  base_deps: { missing: [] },
  bash: { path: '/opt/homebrew/bin/bash', major: 5, ok: true },
  projects: [],
  ...o,
});

describe('daemon checklist', () => {
  it('all fine: one "齐全" row and gh signed in; nothing to run', () => {
    expect(checklist(base()).map((r) => [r.id, r.ok, r.command])).toEqual([
      ['tools', true, null],
      ['gh', true, null],
    ]);
  });

  it('missing tools, gh signed out, macOS bash 3.2: one row each with a command', () => {
    const rows = checklist(base({ base_deps: { missing: ['tmux', 'flock', 'launchctl'] }, gh: { installed: true, logged_in: false }, bash: { path: '/bin/bash', major: 3, ok: false } }));
    expect(rows.map((r) => [r.id, r.ok, r.command])).toEqual([
      ['tool:tmux', false, 'brew install tmux'],
      ['tool:flock', false, 'brew install flock'],
      // part of the system: no command to offer
      ['tool:launchctl', false, null],
      ['gh', false, 'gh auth login'],
      ['bash', false, 'brew install bash'],
    ]);
  });

  it('gh missing is a missing tool (no separate sign-in row); an unreadable bash version is not "fine"', () => {
    const rows = checklist(base({ base_deps: { missing: ['gh'] }, gh: { installed: false, logged_in: null }, bash: { path: '/x/bash', major: null, ok: null } }));
    expect(rows.map((r) => [r.id, r.ok])).toEqual([
      ['tool:gh', false],
      ['bash', null],
    ]);
  });

  it('a status script without the bash field: no bash row', () => {
    const { bash: _, ...rest } = base();
    expect(checklist(rest as LocalStatus).some((r) => r.id === 'bash')).toBe(false);
  });

  it('install commands per system; agents by their own installer; nothing for an odd name', () => {
    expect(installCommand('jq', 'Linux')).toBe('sudo apt-get install -y jq');
    expect(installCommand('flock', 'Linux')).toBe('sudo apt-get install -y util-linux');
    expect(installCommand('claude', 'Darwin')).toBe('npm install -g @anthropic-ai/claude-code');
    expect(installCommand('codex', 'Linux')).toBe('npm install -g @openai/codex');
    expect(installCommand('x; rm -rf ~', 'Darwin')).toBeNull();
    expect(installCommand('tmux', 'FreeBSD')).toBeNull();
  });

  it('every RESULT word of the refresh script has its own words; an unknown one says what it was', () => {
    for (const w of ['replaced', 'unchanged', 'unknown', 'lint_failed', 'lock_timeout', 'not_found', 'not_macos', 'failed', 'needs_human', 'unconfirmed']) {
      expect(refreshWord(w)).not.toContain(w);
    }
    expect(refreshWord('weird')).toContain('weird');
    // "failed" is the script's own "not done, restored"; a run with no final result never reads like that
    expect(refreshWord('failed')).toContain('已恢复原样');
    expect(refreshWord('needs_human')).not.toContain('已恢复');
    expect(refreshWord('unconfirmed')).not.toContain('已恢复');
    expect(refreshWord('unconfirmed')).toContain('需要人处理');
  });
});
