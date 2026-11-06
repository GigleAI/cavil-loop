#!/usr/bin/env node
// The update manifest of one client release (GitHub#184): `latest.json`, the file the app's
// updater reads (src-tauri/crates/core/src/update.rs picks the release, Tauri's updater plugin
// reads this). Run by the release job on the packages the two Macs built.
//
// The public key is the app's own: `plugins.updater.pubkey` in src-tauri/tauri.conf.json — the
// one place the app (at run time), the bundler (when it signs) and this script read it from.
//
// Refuses (exit 1, nothing written) unless, for both Apple silicon and Intel:
//   - the package and its signature are there,
//   - the signature verifies, as minisign: the package's bytes against the signature, and the
//     trusted comment against the global signature, with that public key — a package any
//     installed app would refuse is never published,
//   - a signature bound to a version is bound to this version.
// An app without a public key cannot update itself at all, so an empty key is refused too.
//
//   node scripts/update-manifest.mjs --version 0.5.0 --dir dist-release --conf src-tauri/tauri.conf.json \
//        --notes RELEASE_NOTES.md --out dist-release/latest.json
//   node scripts/update-manifest.mjs --verify <file> <file.sig> [--conf …]   (exit 0 = verifies with the app's key)
//   node scripts/update-manifest.mjs --set-pubkey <key.pub> [--conf …]      (the maintainer's step: put the key in)
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'GigleAI/cavil-loop';
/** the updater's platform names → the arch in the package's file name */
export const PLATFORMS = { 'darwin-aarch64': 'arm64', 'darwin-x86_64': 'x64' };

export const packageName = (version, arch) => `Cavil-Loop-${version}-${arch}.app.tar.gz`;
export const downloadUrl = (version, file) => `https://github.com/${REPO}/releases/download/client/v${version}/${file}`;

/** The app's public key as written in tauri.conf.json ('' when there is none). */
export function configuredPubkey(confPath) {
  const c = JSON.parse(readFileSync(confPath, 'utf8'));
  return String(c?.plugins?.updater?.pubkey ?? '').trim();
}

/** Tauri wraps minisign files in one more base64 layer. → the minisign text, or null. */
function unwrap(b64) {
  const s = String(b64 ?? '').trim();
  if (!s || !/^[A-Za-z0-9+/=\s]+$/.test(s)) return null;
  const text = Buffer.from(s, 'base64').toString('utf8');
  return text.startsWith('untrusted comment:') ? text : null;
}

/** minisign public key → { id, key } (8-byte key id hex, 32-byte Ed25519 key), or null. */
export function parsePubkey(b64) {
  const text = unwrap(b64);
  const raw = text ? Buffer.from((text.split('\n')[1] ?? '').trim(), 'base64') : Buffer.alloc(0);
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') return null;
  return { id: raw.subarray(2, 10).toString('hex'), key: raw.subarray(10) };
}

/** minisign signature → its parts, or null when it is not one. */
export function parseSignature(b64) {
  const text = unwrap(b64);
  if (!text) return null;
  const lines = text.split('\n');
  const raw = Buffer.from((lines[1] ?? '').trim(), 'base64');
  const tc = lines[2] ?? '';
  const global = Buffer.from((lines[3] ?? '').trim(), 'base64');
  const alg = raw.subarray(0, 2).toString('latin1');
  if (raw.length !== 74 || !['Ed', 'ED'].includes(alg) || !tc.startsWith('trusted comment: ') || global.length !== 64) return null;
  return { alg, id: raw.subarray(2, 10).toString('hex'), sig: raw.subarray(10), trusted: tc.slice('trusted comment: '.length), global };
}

/** The 8-byte key id inside a public key or a signature, as hex; null when it is neither. */
export function keyId(b64) {
  return (parsePubkey(b64) ?? parseSignature(b64))?.id ?? null;
}

const edKey = (raw) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });

/**
 * Does `sigB64` (a Tauri .sig) verify `data` with `pubB64`? → { ok: true, trusted } or { ok: false, why }.
 * minisign: "ED" signs the BLAKE2b-512 of the data, legacy "Ed" the data itself; the global
 * signature covers the signature plus the trusted comment (where the bound version lives).
 */
export function verifySignature(data, sigB64, pubB64) {
  const pk = parsePubkey(pubB64);
  if (!pk) return { ok: false, why: '公钥不是 minisign 公钥' };
  const s = parseSignature(sigB64);
  if (!s) return { ok: false, why: '签名文件看不懂' };
  if (s.id !== pk.id) return { ok: false, why: `签名用的密钥（${s.id}）不是 App 里公钥对应的那把（${pk.id}）` };
  const key = edKey(pk.key);
  const signed = s.alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, signed, key, s.sig)) return { ok: false, why: '签名和包的内容对不上' };
  if (!verify(null, Buffer.concat([s.sig, Buffer.from(s.trusted, 'utf8')]), key, s.global)) return { ok: false, why: '签名的可信注释被改过' };
  return { ok: true, trusted: s.trusted };
}

/** The version a verified trusted comment binds the signature to (Tauri's `--app-version`), or null. */
export function signedVersion(trusted) {
  return /\bversion:(\S+)/.exec(trusted ?? '')?.[1] ?? null;
}

/** → { ok: true, manifest } or { ok: false, errors } */
export function build({ version, dir, pubkey, notes, date }) {
  const errors = [];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) errors.push(`版本号不是 X.Y.Z：${version}`);
  if (!String(pubkey ?? '').trim()) errors.push('App 里没有更新用的公钥（tauri.conf.json 的 plugins.updater.pubkey 是空的）：装好的 App 没法校验任何更新包');
  else if (!parsePubkey(pubkey)) errors.push('tauri.conf.json 的 plugins.updater.pubkey 不是 minisign 公钥');
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
    if (parsePubkey(pubkey)) {
      const v = verifySignature(readFileSync(join(dir, file)), signature, pubkey);
      if (!v.ok) errors.push(`${arch}：${v.why}`);
      else {
        const bound = signedVersion(v.trusted);
        if (bound !== null && bound !== version) errors.push(`${arch}：签名绑定的版本是 ${bound}，不是 ${version}`);
      }
    }
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
  // the app's config next to this script (client/src-tauri/tauri.conf.json), whatever the current directory
  const conf = opt('conf') ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'tauri.conf.json');
  const pubkey = existsSync(conf) ? configuredPubkey(conf) : '';
  if (a[0] === '--set-pubkey') {
    const text = read(a[1]).trim();
    if (!parsePubkey(text)) {
      console.log(`❌ ${a[1]} 不是 minisign 公钥文件（读不到，或内容不对），${conf} 没有改`);
      process.exit(1);
    }
    const c = JSON.parse(readFileSync(conf, 'utf8'));
    c.plugins = { ...(c.plugins ?? {}), updater: { ...(c.plugins?.updater ?? {}), pubkey: text } };
    writeFileSync(conf, `${JSON.stringify(c, null, 2)}\n`);
    console.log(`✅ 已把公钥（密钥编号 ${parsePubkey(text).id}）写进 ${conf}`);
    process.exit(0);
  }
  if (a[0] === '--verify') {
    const v = verifySignature(readFileSync(a[1]), read(a[2]), pubkey);
    console.log(v.ok ? `✅ ${a[1]}：签名有效（${v.trusted}）` : `❌ ${a[1]}：${v.why}`);
    process.exit(v.ok ? 0 : 1);
  }
  const r = build({ version: opt('version'), dir: opt('dir') ?? '.', pubkey, notes: read(opt('notes')) });
  if (!r.ok) {
    for (const e of r.errors) console.log(`❌ ${e}`);
    process.exit(1);
  }
  writeFileSync(opt('out') ?? 'latest.json', `${JSON.stringify(r.manifest, null, 2)}\n`);
  console.log(`✅ ${opt('out') ?? 'latest.json'}：${r.manifest.version}，${Object.keys(r.manifest.platforms).join(' / ')}`);
}
