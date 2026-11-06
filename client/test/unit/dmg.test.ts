// The dmg window (GitHub#153): the first-open command is defined once
// (scripts/release-command.mjs) and every copy a user can see or copy says
// exactly that; every file the dmg lists exists and sits in the part of the
// window Finder shows (GitHub#151: the layout is scripts/dmg-layout.mjs, built by dmgbuild).
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_COMMAND, DMG_EXTRA_FILES } from '../../scripts/release-command.mjs';
import { DMG_ICONS } from '../../scripts/dmg-layout.mjs';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** every `xattr …` command written in a file, as it reads to a user (HTML entities decoded) */
function commandsIn(text: string): string[] {
  const decoded = text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return [...decoded.matchAll(/xattr [^\n<`]*?\.app"/g)].map((m) => m[0]);
}

/** the dmg window entries (scripts/dmg-layout.mjs, what scripts/make-dmg.mjs hands to dmgbuild) */
function dmgContents(): { x?: number; y?: number; type?: string; path?: string }[] {
  return DMG_ICONS.map((i) => ({ ...i }));
}

describe('the first-open command', () => {
  it('is the one command that removes the quarantine mark from the installed app', () => {
    expect(RELEASE_COMMAND).toBe('xattr -dr com.apple.quarantine "/Applications/Cavil Loop.app"');
  });

  for (const file of ['build/复制放行命令.html', 'build/打不开时看这里.txt', 'build/dmg-background.html', 'RELEASE_NOTES.md', 'scripts/mac-open-check.sh']) {
    it(`${file} carries exactly that command (and no other)`, () => {
      const found = commandsIn(read(file));
      expect(found.length).toBeGreaterThan(0);
      // mac-open-check.sh also runs the real steps (xattr -w / -p); only the documented command is compared
      const shown = file.endsWith('.sh') ? found.filter((c) => c.startsWith('xattr -dr')) : found;
      expect(shown.length).toBeGreaterThan(0);
      for (const c of shown) expect(c).toBe(RELEASE_COMMAND);
    });
  }

  it('the copy page copies the text of the element it shows (one command, nothing else in it)', () => {
    const html = read('build/复制放行命令.html');
    const m = html.match(/<code id="cmd">([^<]*)<\/code>/);
    expect(m?.[1]).toBe(RELEASE_COMMAND);
  });

  it('the copy page is static: no external resource of any kind', () => {
    const html = read('build/复制放行命令.html');
    expect(html).not.toMatch(/\b(src|href)\s*=/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/@import|url\(/i);
  });
});

describe('dmg window contents', () => {
  const contents = dmgContents();

  it('lists the app, the Applications link and every extra file', () => {
    expect(contents.length).toBe(2 + DMG_EXTRA_FILES.length);
    expect(contents.some((c) => c.type === 'link' && c.path === '/Applications')).toBe(true);
    expect(contents.filter((c) => c.type === 'file').map((c) => c.path).sort()).toEqual([...DMG_EXTRA_FILES].sort());
  });

  it('every listed file exists', () => {
    for (const p of [...contents.filter((x) => x.type === 'file').map((c) => c.path!), ...DMG_EXTRA_FILES]) expect(existsSync(join(root, p)), p).toBe(true);
  });

  it('every icon sits inside the visible part of the window (top ~430 px, 660 wide) and none overlap', () => {
    for (const c of contents) {
      expect(c.y!, c.path ?? 'app').toBeLessThanOrEqual(400);
      expect(c.x!).toBeGreaterThanOrEqual(60);
      expect(c.x!).toBeLessThanOrEqual(600);
    }
    for (let i = 0; i < contents.length; i++)
      for (let j = i + 1; j < contents.length; j++) {
        const [a, b] = [contents[i], contents[j]];
        const apart = Math.abs(a.x! - b.x!) >= 140 || Math.abs(a.y! - b.y!) >= 120;
        expect(apart, `${a.path ?? 'app'} vs ${b.path ?? 'app'}`).toBe(true);
      }
  });

  it('the background tells the user about the copy page', () => {
    expect(read('build/dmg-background.html')).toContain('复制放行命令');
  });
});
