#!/usr/bin/env node
// 发图前自查：这些文件公网拿不拿得到？里面有没有凭证？
//
// 用法：node check.mjs [--root <资产目录>] <文件或目录>...
//
// 逐个文件报「公网拿得到 / 拿不到 + 原因」（规则和对外服务 serve.mjs 是同一份 rules.mjs）。
// 任何文件——不论类型、不论多大——内容里有凭证样式，就点名报出来并以退出码 1 结束：这种文件不该出现
// 在资产目录里，哪怕对外服务不会交出它。只报命中的种类，不输出值。
// 退出码：0 = 没发现凭证；1 = 有文件含凭证样式；2 = 用法错误。
// 给了 --root（或设了 PUBLIC_ASSETS_ROOT）时，还会核对文件是不是真的在资产目录内。
import fs from 'fs';
import path from 'path';
import { findSecretsInFile, judgeFile } from './rules.mjs';

const args = process.argv.slice(2);
let root = process.env.PUBLIC_ASSETS_ROOT || '';
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = args[++i] || '';
  else if (args[i].startsWith('--')) {
    console.error(`未知参数: ${args[i]}`);
    process.exit(2);
  } else targets.push(args[i]);
}
if (!targets.length) {
  console.error('用法：node check.mjs [--root <资产目录>] <文件或目录>...');
  process.exit(2);
}

const files = [];
const walk = (p) => {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    console.error(`找不到：${p}`);
    process.exit(2);
  }
  if (st.isDirectory()) for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n));
  else files.push(p);
};
targets.forEach(walk);

let secretFiles = 0;
let pub = 0;
let priv = 0;
for (const f of files) {
  let real;
  try {
    real = fs.realpathSync(f);
  } catch {
    console.log(`拿不到  ${f} — 悬空的符号链接`);
    priv++;
    continue;
  }
  // 没给资产目录时，把文件所在目录当作根：只判类型和内容，不判位置。
  const base = root ? fs.realpathSync(root) : path.dirname(real);
  const verdict = judgeFile(base, real);
  // 每个文件都完整扫一遍（按块读，不论多大）；读不了就当场报错退出，不把「没扫」当「没有」。
  let kinds = [];
  if (fs.statSync(real).isFile()) {
    try {
      kinds = findSecretsInFile(real);
    } catch (e) {
      console.log(`❌ 读不了  ${f} — 没法检查内容（${e.code || e.message}）；不能发布`);
      process.exit(1);
    }
  }
  if (kinds.length) {
    secretFiles++;
    console.log(`❌ 凭证  ${f} — 内容里有凭证样式（${kinds.join('、')}）；把它移出资产目录`);
  } else if (verdict.ok) {
    pub++;
    console.log(`拿得到  ${f}`);
  } else {
    priv++;
    console.log(`拿不到  ${f} — ${verdict.reason}`);
  }
}
console.log(`共 ${files.length} 个文件：公网拿得到 ${pub}，拿不到 ${priv}，含凭证样式 ${secretFiles}`);
process.exit(secretFiles ? 1 : 0);
