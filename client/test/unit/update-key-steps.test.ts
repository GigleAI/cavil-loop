// The maintainer's update-key steps in client/README.md (GitHub#184, review rounds 1–2 of PR #189):
// the three blocks between <!-- update-key-steps:<name>:begin --> and :end are taken out of the
// README word for word and run in a pseudo-terminal, the way a person types them — the CLI asks for
// the password there (twice to make the key, once to sign). Its own HOME (where ~/.tauri ends up)
// and a copy of client/ (whose tauri.conf.json the steps change). The lifecycle the README promises
// is walked through: the normal way; a wrong password at signing → only the check block again →
// verified, the key files unchanged; making the key again is refused → the replace block → a new
// key, checked.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** One of the README's blocks, verbatim (fence lines dropped). */
function block(name: 'generate' | 'check' | 'replace'): string {
  const md = readFileSync(join(root, 'README.md'), 'utf8');
  const m = new RegExp(`<!-- update-key-steps:${name}:begin -->\\n\`\`\`bash\\n([\\s\\S]*?)\\n\`\`\`\\n<!-- update-key-steps:${name}:end -->`).exec(md);
  if (!m) throw new Error(`README 里找不到 update-key-steps:${name} 那段命令`);
  return m[1];
}

// Runs `bash -e -c <script>` on a pseudo-terminal. Whenever the output so far ends in a line asking
// for a password and waiting ("...: "), types the next password from the list. Reports every prompt
// it answered, so a test can say which ones came.
const DRIVER = String.raw`
import json, os, pty, select, sys, time
cwd, home, script, passwords = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
env = dict(os.environ, HOME=home)
for k in ("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "TAURI_SIGNING_PRIVATE_KEY_PATH", "CI"):
    env.pop(k, None)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe("bash", ["bash", "-e", "-c", script], env)
out, answered, prompts, t0 = b"", 0, [], time.time()
while time.time() - t0 < 180:
    r, _, _ = select.select([fd], [], [], 0.2)
    if not r:
        continue
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    out += d
    tail = out[answered:]
    last = tail.rsplit(b"\n", 1)[-1].replace(b"\r", b"")
    if b"assword" in last and last.rstrip().endswith(b":"):
        prompts.append(last.strip().decode(errors="replace"))
        os.write(fd, (passwords[len(prompts) - 1] if len(prompts) <= len(passwords) else "").encode() + b"\r")
        answered = len(out)
_, status = os.waitpid(pid, 0)
print(json.dumps({"code": os.waitstatus_to_exitcode(status), "prompts": prompts, "out": out.decode(errors="replace")}))
`;

type Run = { code: number; prompts: string[]; out: string };

/** A fresh HOME and a copy of client/ to run the blocks in. */
function place() {
  const home = tempDir();
  // a git repository with client/ inside, like a checkout; the blocks run from its top (not from client/)
  const repo = tempDir();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const work = join(repo, 'client');
  mkdirSync(join(work, 'src-tauri'), { recursive: true });
  cpSync(join(root, 'scripts'), join(work, 'scripts'), { recursive: true });
  cpSync(join(root, 'src-tauri', 'tauri.conf.json'), join(work, 'src-tauri', 'tauri.conf.json'));
  writeFileSync(join(work, 'package.json'), readFileSync(join(root, 'package.json')));
  symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'));
  const run = (script: string, passwords: string[]): Run => {
    const raw = execFileSync('python3', ['-c', DRIVER, repo, home, script, JSON.stringify(passwords)], { encoding: 'utf8', timeout: 200_000 });
    return JSON.parse(raw.trim().split('\n').pop()!);
  };
  const key = join(home, '.tauri', 'cavil-loop-updater.key');
  const files = () => ({ key: digest(key), pub: digest(`${key}.pub`) });
  const confKey = () => JSON.parse(readFileSync(join(work, 'src-tauri', 'tauri.conf.json'), 'utf8')).plugins.updater.pubkey as string;
  return { home, work, run, key, files, confKey };
}

const digest = (f: string) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null);
const keyId = (pub: string) => Buffer.from((Buffer.from(pub.trim(), 'base64').toString('utf8').split('\n')[1] ?? '').trim(), 'base64').subarray(2, 10).toString('hex');
const VALID = /✅ .*cavil-key-check\.txt：签名有效/;
const PW = 's3cret';

describe('the maintainer\'s update-key steps, as written in the README (GitHub#184)', () => {
  it('the normal way: make the key pair (with a password), put the public key in, sign and verify a file', () => {
    const p = place();
    const g = p.run(block('generate'), [PW, PW]);
    expect(g.code, g.out.slice(-1500)).toBe(0);
    expect(g.prompts).toHaveLength(2);
    expect(existsSync(p.key) && existsSync(`${p.key}.pub`)).toBe(true);
    const c = p.run(block('check'), [PW]);
    expect(c.code, c.out.slice(-1500)).toBe(0);
    expect(c.prompts).toHaveLength(1);
    expect(p.confKey()).toBe(readFileSync(`${p.key}.pub`, 'utf8').trim());
    expect(c.out).toMatch(/已把公钥（密钥编号 [0-9a-f]{16}）写进/);
    expect(c.out).toMatch(VALID);
  }, 200_000);

  it('a wrong password at signing stops there; running only the check block again, with the right one, verifies — the key files never change', () => {
    const p = place();
    expect(p.run(block('generate'), [PW, PW]).code).toBe(0);
    const made = p.files();
    const bad = p.run(block('check'), ['wrong']);
    expect(bad.code).not.toBe(0);
    expect(bad.prompts).toHaveLength(1); // it reached the signing step
    expect(bad.out).not.toMatch(/签名有效/);
    expect(existsSync(join(p.home, 'cavil-key-check.txt.sig'))).toBe(false);
    expect(p.files()).toEqual(made);
    // what the README says to do: the check block again
    const again = p.run(block('check'), [PW]);
    expect(again.code, again.out.slice(-1500)).toBe(0);
    expect(again.out).toMatch(VALID);
    expect(p.files()).toEqual(made);
    expect(p.confKey()).toBe(readFileSync(`${p.key}.pub`, 'utf8').trim());
  }, 200_000);

  it('making the key again is refused (it is never overwritten); the replace block, then both blocks: a new key, checked', () => {
    const p = place();
    expect(p.run(block('generate'), [PW, PW]).code).toBe(0);
    expect(p.run(block('check'), [PW]).code).toBe(0);
    const old = p.files();
    const oldId = keyId(p.confKey());
    const again = p.run(block('generate'), ['other', 'other']);
    expect(again.code).not.toBe(0);
    expect(again.out).toMatch(/already exists/);
    expect(p.files()).toEqual(old);
    expect(p.run(block('replace'), []).code).toBe(0);
    expect(existsSync(p.key) || existsSync(`${p.key}.pub`)).toBe(false);
    expect(p.run(block('generate'), ['other', 'other']).code).toBe(0);
    const c = p.run(block('check'), ['other']);
    expect(c.code, c.out.slice(-1500)).toBe(0);
    expect(c.out).toMatch(VALID);
    expect(p.files()).not.toEqual(old);
    expect(keyId(p.confKey())).not.toBe(oldId);
  }, 200_000);
});
