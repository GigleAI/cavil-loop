#!/usr/bin/env node
// 严格模式的共用部分（GitHub#613）：对外服务（serve.mjs）、切换命令（switch.sh）、发布命令
// （scripts/publish-asset.sh）都只经这里判断同一件事，不各写一份。
//
//   code-id <目录>                   这套服务代码的指纹（serve.mjs + rules.mjs + strict.mjs 的内容）
//   status-check <状态文件>          对外服务自己报告的状态 + 切换验收，按 enforced / strict-unverified / not-enforced / unknown 归类
//   accept <状态文件>                切换命令核验通过后写验收记录（只对状态文件此刻记录的那个进程）
//   keys <配置目录>...               本机登记过的项目 key（目录里带 PROJECT_ROOT= 行的 <key>.conf）
//   build <资产目录> <输出> <上限字节> <配置目录>...   建旧图清单
//   verify <清单> <校验值>            清单文件的 SHA-256 是否等于校验值（退出码 0 / 1）
//
// 输出给脚本读的一律是一行 JSON（status-check）或一行一个值（keys / code-id）。
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { MEDIA_TYPES, PROJECT_KEY_RE, ITEM_RE, judgeBuffer } from './rules.mjs';

export const RULES_VERSION = 2;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const CODE_FILES = ['serve.mjs', 'rules.mjs', 'strict.mjs'];
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// 这套代码的指纹：三个文件按固定顺序拼起来取 SHA-256。服务启动时记下自己的，切换命令拿磁盘上的比。
export function codeId(dir = HERE) {
  const h = crypto.createHash('sha256');
  for (const f of CODE_FILES) h.update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

// /proc/<pid>/stat 的第 22 个字段（进程启动时刻，开机以来的时钟滴答数）。读不到返回 null。
// 进程名可能含空格和括号，所以从最后一个 ')' 之后数。
export function procStart(pid) {
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const rest = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  const v = rest[19];
  return /^[0-9]+$/.test(v || '') ? v : null;
}

// 本机登记过的项目 key：配置目录里带 PROJECT_ROOT= 行的 <key>.conf（setup.sh 写的每个项目都有）。
// 目录不存在算没有；目录在但读不出就抛错——调用方当「不知道」，不当「没有项目」。
export function projectKeys(dirs) {
  const keys = new Set();
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    for (const n of names) {
      if (!n.endsWith('.conf')) continue;
      const key = n.slice(0, -5);
      if (!PROJECT_KEY_RE.test(key)) continue;
      const text = fs.readFileSync(path.join(dir, n), 'utf8');
      if (/^PROJECT_ROOT=/m.test(text)) keys.add(key);
    }
  }
  return keys;
}

// 切换命令核验通过后写的验收记录：和状态文件放在同一个目录。
export const acceptFileFor = (statusFile) => path.join(path.dirname(statusFile), 'accepted.json');

// 对外服务写的状态文件，加上切换命令写的验收记录，归成四类。只有 enforced 才算「服务端拦截已生效」：
// 文件能读、字段齐、规则版本够、严格模式开、旧图清单可用、记录的进程此刻还在且启动时刻对得上，
// **而且**验收记录对的正是这个进程（进程号、启动时刻、代码、清单校验值都一样）。
// 服务已在严格模式、但还没有对得上的验收记录 → strict-unverified（新规则在跑，核验没完成：
// 切换被中断、服务自己重启过……），发布命令不认它，自动切换会重新核验。
// 服务明说严格模式关 → not-enforced；其他一律 unknown。
export function statusCheck(file, acceptFile = acceptFileFor(file)) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { state: 'unknown', reason: e.code === 'ENOENT' ? '没有状态文件（服务没跑过新版本）' : '状态文件读不出' };
  }
  const need = { rules: 'number', strict: 'boolean', root: 'string', pid: 'number', start: 'string', code: 'string', legacy_ok: 'boolean' };
  for (const [k, t] of Object.entries(need)) {
    if (typeof st[k] !== t) return { state: 'unknown', reason: `状态文件缺字段 ${k}` };
  }
  const alive = procStart(st.pid);
  if (alive === null) return { state: 'unknown', reason: '状态文件记录的进程已不在' };
  if (alive !== st.start) return { state: 'unknown', reason: '状态文件记录的进程号已被别的进程占用' };
  const base = { root: st.root, code: st.code, pid: st.pid, legacy_sha: st.legacy_sha || '' };
  if (st.rules < RULES_VERSION) return { ...base, state: 'not-enforced', reason: '服务跑的是旧规则版本' };
  if (!st.strict) return { ...base, state: 'not-enforced', reason: '服务报告严格模式关' };
  if (!st.legacy_ok) return { ...base, state: 'not-enforced', reason: `旧图清单不可用（${st.legacy_why || '原因未记'}）` };
  let acc;
  try {
    acc = JSON.parse(fs.readFileSync(acceptFile, 'utf8'));
  } catch (e) {
    return { ...base, state: 'strict-unverified', reason: e.code === 'ENOENT' ? '严格模式在跑，切换核验还没完成' : '验收记录读不出' };
  }
  for (const k of ['pid', 'start', 'code', 'legacy_sha']) {
    if (acc === null || typeof acc !== 'object' || acc[k] !== st[k]) {
      return { ...base, state: 'strict-unverified', reason: '验收记录对的不是现在这个服务进程（服务重启过或核验没完成）' };
    }
  }
  return { ...base, state: 'enforced', reason: '' };
}

// 验收：只在状态文件此刻正是这个进程、严格模式在跑时写，内容取自状态文件本身。
export function acceptNow(file, acceptFile = acceptFileFor(file)) {
  const v = statusCheck(file, acceptFile);
  if (v.state !== 'strict-unverified' && v.state !== 'enforced') return { ok: false, why: v.reason || v.state };
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rec = { pid: st.pid, start: st.start, code: st.code, legacy_sha: st.legacy_sha, at: new Date().toISOString() };
  const tmp = `${acceptFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, acceptFile);
  return { ok: true };
}

// 读旧图清单：文件的 SHA-256 必须等于校验值、记录的目录必须是服务实际交出的目录。
// 返回 { ok, map, why }；map 是 相对路径 → { size, sha256 }。
export function loadLegacy(lists, wantSha, realRoot) {
  if (!HEX64.test(wantSha || '')) return { ok: false, why: '配置里没有可用的清单校验值' };
  const why = [];
  for (const list of lists) {
    let raw;
    try {
      raw = fs.readFileSync(list);
    } catch (e) {
      why.push(`${list}：${e.code || '读不出'}`);
      continue;
    }
    if (sha256(raw) !== wantSha) {
      why.push(`${list}：校验值不符`);
      continue;
    }
    let j;
    try {
      j = JSON.parse(raw.toString('utf8'));
    } catch {
      why.push(`${list}：不是 JSON`);
      continue;
    }
    if (j.version !== 1 || typeof j.files !== 'object' || j.files === null) {
      why.push(`${list}：格式不对`);
      continue;
    }
    if (j.root !== realRoot) {
      why.push(`${list}：记录的目录不是服务交出的目录`);
      continue;
    }
    const map = new Map();
    for (const [rel, v] of Object.entries(j.files)) map.set(rel, v);
    return { ok: true, map, list };
  }
  return { ok: false, why: why.join('；') || '没有清单' };
}

// 建旧图清单：资产目录里、不在项目子目录下的全部图片 / 视频（普通文件，不跟符号链接），逐个整份读进
// 内存，按对外服务同一套规则判（judgeBuffer），记相对路径、大小、SHA-256。
// 超过上限的文件 → 整个失败（列出来）：上限以上的旧图切换后交不出，不能悄悄丢掉。
// 判不过的（含凭证、改了扩展名的……）→ 不登记，列出来：它们现在本来也不该对外。
export function buildLegacy(root, maxBytes, keys) {
  const realRoot = fs.realpathSync(root);
  const files = {};
  const oversize = [];
  const skipped = [];
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir).sort()) {
      if (n.startsWith('.')) continue;
      const p = path.join(dir, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = path.relative(realRoot, p);
      const segs = rel.split(path.sep);
      if (segs.length === 3 && keys.has(segs[0]) && ITEM_RE.test(segs[1])) continue;
      const ext = path.extname(n).slice(1).toLowerCase();
      if (!MEDIA_TYPES[ext]) continue;
      if (st.size > maxBytes) {
        oversize.push(`${rel}（${st.size} 字节）`);
        continue;
      }
      const data = fs.readFileSync(p);
      const v = judgeBuffer(p, data);
      if (!v.ok) {
        skipped.push(`${rel} — ${v.reason}`);
        continue;
      }
      files[rel] = { size: data.length, sha256: sha256(data) };
    }
  };
  walk(realRoot);
  return { realRoot, files, oversize, skipped };
}

function main(argv) {
  const [cmd, ...a] = argv;
  switch (cmd) {
    case 'code-id':
      console.log(codeId(a[0] || HERE));
      return 0;
    case 'status-check':
      console.log(JSON.stringify(statusCheck(a[0])));
      return 0;
    case 'accept': {
      const r = acceptNow(a[0]);
      if (!r.ok) console.error(`没写验收记录：${r.why}`);
      return r.ok ? 0 : 1;
    }
    case 'keys': {
      let keys;
      try {
        keys = projectKeys(a);
      } catch (e) {
        console.error(`读不出配置目录：${e.code || e.message}`);
        return 3;
      }
      for (const k of [...keys].sort()) console.log(k);
      return 0;
    }
    case 'build': {
      const [root, out, maxStr, ...dirs] = a;
      const max = Number(maxStr);
      if (!root || !out || !Number.isInteger(max) || max <= 0) {
        console.error('用法：strict.mjs build <资产目录> <输出> <上限字节> <配置目录>...');
        return 2;
      }
      let keys;
      try {
        keys = projectKeys(dirs);
      } catch (e) {
        console.error(`读不出配置目录：${e.code || e.message}`);
        return 3;
      }
      const r = buildLegacy(root, max, keys);
      for (const s of r.skipped) console.error(`不登记：${s}`);
      if (r.oversize.length) {
        for (const s of r.oversize) console.error(`超过上限：${s}`);
        console.error(`有 ${r.oversize.length} 个旧图超过单文件上限 ${max} 字节：在 public-assets.conf 里调大 PUBLIC_ASSETS_MAX_BYTES 后再切换`);
        return 4;
      }
      const sorted = {};
      for (const k of Object.keys(r.files).sort()) sorted[k] = r.files[k];
      fs.writeFileSync(out, JSON.stringify({ version: 1, root: r.realRoot, files: sorted }) + '\n', { mode: 0o600 });
      console.error(`旧图清单：登记 ${Object.keys(sorted).length} 个，不登记 ${r.skipped.length} 个`);
      return 0;
    }
    case 'verify': {
      try {
        return sha256(fs.readFileSync(a[0])) === a[1] ? 0 : 1;
      } catch {
        return 1;
      }
    }
    default:
      console.error('用法：strict.mjs code-id|status-check|keys|build|verify …');
      return 2;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  process.exit(main(process.argv.slice(2)));
}
