#!/usr/bin/env node
// The update manifest of one client release (GitHub#184): `latest.json`, the file the app's
// updater reads (src-tauri/crates/core/src/update.rs picks the release, Tauri's updater plugin
// reads this). Run by the release job on the packages the two Macs built.
//
// Refuses (exit 1, nothing written) unless, for both Apple silicon and Intel:
//   - the package and its signature are there,
//   - the signature was made with the key whose public half the app carries (src-tauri/updater.pub)
//     — a package signed with any other key would be refused by every installed app,
//   - a signature bound to a version is bound to this version.
// An app without a public key cannot update itself at all, so an empty updater.pub is refused too.
//
//   node scripts/update-manifest.mjs --version 0.5.0 --dir dist-release --pubkey src-tauri/updater.pub \
//        --notes RELEASE_NOTES.md --out dist-release/latest.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = 'GigleAI/cavil-loop';
/** the updater's platform names → the arch in the package's file name */
export const PLATFORMS = { 'darwin-aarch64': 'arm64', 'darwin-x86_64': 'x64' };

export const packageName = (version, arch) => `Cavil-Loop-${version}-${arch}.app.tar.gz`;
export const downloadUrl = (version, file) => `https://github.com/${REPO}/releases/download/client/v${version}/${file}`;

/** The 8-byte key id inside a minisign public key or signature, as hex; null when it is not one. */
export function keyId(b64) {
  let text;
  try {
    text = Buffer.from(String(b64).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const line = text.split('\n')[1];
  if (!line) return null;
  const raw = Buffer.from(line.trim(), 'base64');
  return raw.length >= 10 ? raw.subarray(2, 10).toString('hex') : null;
}

/** The version a signature is bound to (Tauri's `--app-version`), or null when it names none. */
export function signedVersion(b64) {
  const text = Buffer.from(String(b64).trim(), 'base64').toString('utf8');
  const trusted = text.split('\n').find((l) => l.startsWith('trusted comment:')) ?? '';
  return /\bversion:(\S+)/.exec(trusted)?.[1] ?? null;
}

/** → { ok: true, manifest } or { ok: false, errors } */
export function build({ version, dir, pubkey, notes, date }) {
  const errors = [];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) errors.push(`版本号不是 X.Y.Z：${version}`);
  const want = keyId(pubkey ?? '');
  if (!String(pubkey ?? '').trim()) errors.push('App 里没有更新用的公钥（src-tauri/updater.pub 是空的）：装好的 App 没法校验任何更新包');
  else if (!want) errors.push('src-tauri/updater.pub 不是 minisign 公钥');
  const platforms = {};
  for (const [platform, arch] of Object.entries(PLATFORMS)) {
    const file = packageName(version, arch);
    const sigFile = join(dir, `${file}.sig`);
    if (!existsSync(join(dir, file))) {
      errors.push(`${arch}：没有更新包 ${file}`);
      continue;
    }
    if (!existsSync(sigFile)) {
      errors.push(`${arch}：没有签名 ${file}.sig`);
      continue;
    }
    const signature = readFileSync(sigFile, 'utf8').trim();
    const got = keyId(signature);
    if (!got) errors.push(`${arch}：签名文件看不懂`);
    else if (want && got !== want) errors.push(`${arch}：签名用的密钥（${got}）不是 App 里公钥对应的那把（${want}）`);
    const bound = got ? signedVersion(signature) : null;
    if (bound !== null && bound !== version) errors.push(`${arch}：签名绑定的版本是 ${bound}，不是 ${version}`);
    platforms[platform] = { signature, url: downloadUrl(version, file) };
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: { version, notes: notes ?? '', pub_date: (date ?? new Date()).toISOString(), platforms } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (n) => {
    const i = a.indexOf(`--${n}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const read = (f) => (f && existsSync(f) ? readFileSync(f, 'utf8') : '');
  const r = build({ version: opt('version'), dir: opt('dir') ?? '.', pubkey: read(opt('pubkey')), notes: read(opt('notes')) });
  if (!r.ok) {
    for (const e of r.errors) console.log(`❌ ${e}`);
    process.exit(1);
  }
  writeFileSync(opt('out') ?? 'latest.json', `${JSON.stringify(r.manifest, null, 2)}\n`);
  console.log(`✅ ${opt('out') ?? 'latest.json'}：${r.manifest.version}，${Object.keys(r.manifest.platforms).join(' / ')}`);
}
