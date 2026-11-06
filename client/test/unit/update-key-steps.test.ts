// The maintainer's update-key steps in client/README.md (GitHub#184, review round 1 of PR #189):
// the block between <!-- update-key-steps:begin --> and :end is taken out of the README word for
// word and run in a pseudo-terminal, the way a person types it — the CLI asks for the password
// there (twice to make the key, once to sign). Its own HOME (where ~/.tauri ends up) and a copy of
// client/ (whose tauri.conf.json the steps change). Then: the two files exist, the public key is in
// tauri.conf.json, the check signature verifies — and with a wrong password at the signing step the
// steps stop and nothing says "valid".

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The README's block, verbatim (fence lines dropped). */
function steps(): string[] {
  const md = readFileSync(join(root, 'README.md'), 'utf8');
  const m = /<!-- update-key-steps:begin -->\n```bash\n([\s\S]*?)\n```\n<!-- update-key-steps:end -->/.exec(md);
  if (!m) throw new Error('README 里找不到 update-key-steps 那段命令');
  return m[1].split('\n');
}

// Runs `bash -e -c <steps>` on a pseudo-terminal, typing the next password whenever the CLI asks.
const DRIVER = String.raw`
import json, os, pty, select, sys, time
cwd, home, script, passwords = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
env = dict(os.environ, HOME=home)
env.pop("TAURI_SIGNING_PRIVATE_KEY", None); env.pop("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", None); env.pop("CI", None)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe("bash", ["bash", "-e", "-c", script], env)
out, seen, t0 = b"", 0, time.time()
while time.time() - t0 < 180:
    r, _, _ = select.select([fd], [], [], 0.5)
    if not r:
        continue
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    out += d
    # a prompt: the output so far ends with a line that asks for the password and waits ("...: ")
    last = out.rsplit(b"\n", 1)[-1]
    if b"assword" in last and last.rstrip(b" ").endswith(b":") and not last.endswith(b"\r"):
        os.write(fd, (passwords[seen] if seen < len(passwords) else "").encode() + b"\r")
        seen += 1
        out += b"\n"
_, status = os.waitpid(pid, 0)
print(json.dumps({"code": os.waitstatus_to_exitcode(status), "asked": seen, "out": out.decode(errors="replace")}))
`;

function run(passwords: string[]) {
  const home = tempDir();
  const work = join(tempDir(), 'client');
  mkdirSync(join(work, 'src-tauri'), { recursive: true });
  cpSync(join(root, 'scripts'), join(work, 'scripts'), { recursive: true });
  cpSync(join(root, 'src-tauri', 'tauri.conf.json'), join(work, 'src-tauri', 'tauri.conf.json'));
  writeFileSync(join(work, 'package.json'), readFileSync(join(root, 'package.json')));
  symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'));
  const raw = execFileSync('python3', ['-c', DRIVER, work, home, steps().join('\n'), JSON.stringify(passwords)], { encoding: 'utf8', timeout: 200_000 });
  return { home, work, r: JSON.parse(raw.trim().split('\n').pop()!) as { code: number; asked: number; out: string } };
}

describe('the maintainer\'s update-key steps, as written in the README (GitHub#184)', () => {
  it('make the key pair (with a password), put the public key in, sign and verify a file', () => {
    const { home, work, r } = run(['s3cret', 's3cret', 's3cret']);
    expect(r.code, r.out.slice(-1500)).toBe(0);
    expect(r.asked).toBe(3);
    const pub = readFileSync(join(home, '.tauri', 'cavil-loop-updater.key.pub'), 'utf8').trim();
    expect(existsSync(join(home, '.tauri', 'cavil-loop-updater.key'))).toBe(true);
    expect(JSON.parse(readFileSync(join(work, 'src-tauri', 'tauri.conf.json'), 'utf8')).plugins.updater.pubkey).toBe(pub);
    expect(r.out).toMatch(/已把公钥（密钥编号 [0-9a-f]{16}）写进/);
    expect(r.out).toMatch(/✅ .*cavil-key-check\.txt：签名有效/);
  }, 200_000);

  it('a wrong password at the signing step: the steps stop there, nothing says valid', () => {
    const { home, work, r } = run(['s3cret', 's3cret', 'wrong']);
    expect(r.code).not.toBe(0);
    // it got as far as the signing step: the key pair was made and the public key written in
    expect(r.asked).toBe(3);
    expect(existsSync(join(home, '.tauri', 'cavil-loop-updater.key.pub'))).toBe(true);
    expect(JSON.parse(readFileSync(join(work, 'src-tauri', 'tauri.conf.json'), 'utf8')).plugins.updater.pubkey).not.toBe('');
    expect(r.out).not.toMatch(/签名有效/);
    expect(existsSync(join(home, 'cavil-key-check.txt.sig'))).toBe(false);
  }, 200_000);
});
