#!/usr/bin/env node
// 把周报 markdown 渲染成 A4 PDF（极简版式，中文字体，页码）。
//
// 用法: topdf.mjs <node-project-dir> <in.md> <out.pdf> [--title T] [--subtitle S]
//
// 只依赖 playwright（从项目 node_modules 解析，同 shot.mjs）。markdown 用自带的
// 子集渲染器：周报只用到标题 / 表格 / 列表 / 引用 / 图片 / 行内强调这几种，
// 不引第三方 md 库 —— marked 只是项目的传递依赖，哪天被提上去就断了。
import { createRequire } from 'module';
import fs from 'fs';

const args = process.argv.slice(2);
const [projectDir, src, out] = args.filter((x) => !x.startsWith('--'));
const opt = (k) => {
  const i = args.indexOf('--' + k);
  return i < 0 ? '' : args[i + 1];
};
if (!projectDir || !src || !out) {
  console.error('用法: topdf.mjs <node-project-dir> <in.md> <out.pdf> [--title T] [--subtitle S]');
  process.exit(2);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 行内解析。代码先切走存起来，避免里面的符号被后面的规则再解析一遍；
// 占位符用私用区字符，不能用「空格+数字+空格」——正文里 "你 24 条" 这种会被误命中。
const A = '\uE000';
const B = '\uE001';
function inline(t) {
  const code = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => A + (code.push('<code>' + esc(c) + '</code>') - 1) + B);
  t = esc(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, a, u) => `<img alt="${a}" src="${u}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, a, u) => `<a href="${u}">${a}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return t.replace(new RegExp(A + '(\\d+)' + B, 'g'), (_, i) => code[+i]);
}

const cells = (l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
const isNum = (s) => /^[-+]?[$¥]?[\d,.]+%?$/.test(s.replace(/\*\*/g, '').trim());

function render(md) {
  const L = md.split('\n');
  const H = [];
  const para = [];
  let i = 0;
  const flushP = () => {
    if (para.length) H.push('<p>' + inline(para.join(' ')) + '</p>');
    para.length = 0;
  };
  while (i < L.length) {
    const l = L[i];
    // HTML 原样块（<details> / <sub> 等）
    if (/^<(details|summary|sub|div|br|\/)/.test(l.trim())) {
      flushP();
      H.push(l);
      i++;
      continue;
    }
    if (!l.trim()) {
      flushP();
      i++;
      continue;
    }
    if (/^---+$/.test(l.trim())) {
      flushP();
      H.push('<hr>');
      i++;
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      flushP();
      const n = m[1].length;
      H.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
      continue;
    }
    if (l.startsWith('>')) {
      flushP();
      const q = [];
      while (i < L.length && L[i].startsWith('>')) {
        q.push(L[i].replace(/^>\s?/, ''));
        i++;
      }
      H.push('<blockquote>' + render(q.join('\n')) + '</blockquote>');
      continue;
    }
    // 表格：表头行 + 分隔行
    if (l.trim().startsWith('|') && i + 1 < L.length && /^\|[\s:|-]+\|$/.test(L[i + 1].trim())) {
      flushP();
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < L.length && L[i].trim().startsWith('|')) {
        rows.push(cells(L[i]));
        i++;
      }
      // 整列都是数字的，右对齐 + 等宽数字
      const num = head.map((_, c) => rows.length > 0 && rows.every((r) => !r[c] || isNum(r[c])));
      H.push(
        '<table><thead><tr>' +
          head.map((h, c) => `<th class="${num[c] ? 'n' : ''}">${inline(h)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows
            .map(
              (r) =>
                '<tr>' +
                head.map((_, c) => `<td class="${num[c] ? 'n' : ''}">${inline(r[c] || '')}</td>`).join('') +
                '</tr>'
            )
            .join('') +
          '</tbody></table>'
      );
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      flushP();
      const ord = /^\s*\d+\./.test(l);
      const items = [];
      while (i < L.length && /^\s*([-*+]|\d+\.)\s+/.test(L[i])) {
        let t = L[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        i++;
        // 续行（缩进的软换行）并进同一个 li
        while (
          i < L.length &&
          L[i].trim() &&
          !/^\s*([-*+]|\d+\.)\s+/.test(L[i]) &&
          !L[i].trim().startsWith('|') &&
          !L[i].trim().startsWith('>') &&
          !/^#{1,4}\s/.test(L[i])
        ) {
          t += ' ' + L[i].trim();
          i++;
        }
        items.push('<li>' + inline(t) + '</li>');
      }
      const tag = ord ? 'ol' : 'ul';
      H.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    para.push(l.trim());
    i++;
  }
  flushP();
  return H.join('\n');
}

const CSS = `
@page { size: A4; margin: 16mm 14mm; }
:root{--ink:#1a1c1f;--mute:#5b6169;--line:#dfe3e8;--soft:#f5f7f9;--gold:#b8860b;--info:#1f5f9e}
*{box-sizing:border-box}
body{font-family:"Noto Sans CJK SC","Source Han Sans SC","PingFang SC",system-ui,sans-serif;
     color:var(--ink);font-size:10.2pt;line-height:1.62;margin:0}
h1{font-size:21pt;margin:0 0 3pt;letter-spacing:-.4pt;line-height:1.2}
h2{font-size:13.5pt;margin:20pt 0 8pt;padding-bottom:5pt;border-bottom:2px solid var(--ink)}
h3{font-size:11.4pt;margin:15pt 0 6pt;padding-left:8pt;border-left:4px solid var(--gold)}
h4{font-size:10.4pt;margin:12pt 0 4pt;color:var(--mute);border-bottom:1px solid var(--line);
   padding-bottom:3pt}
h2,h3,h4{page-break-after:avoid}
p{margin:0 0 7pt}
table{width:100%;border-collapse:collapse;font-size:9.3pt;margin:7pt 0 10pt;page-break-inside:avoid}
th,td{border:1px solid var(--line);padding:4.5pt 6pt;text-align:left;vertical-align:top}
th{background:var(--soft);font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
ul,ol{margin:4pt 0 10pt;padding-left:17pt} li{margin-bottom:4pt}
blockquote{margin:8pt 0;padding:8pt 11pt;background:var(--soft);
           border-left:3px solid var(--info);font-size:9.6pt}
blockquote p:last-child{margin-bottom:0}
hr{border:0;border-top:1px solid var(--line);margin:14pt 0}
img{max-width:100%;border:1px solid var(--line);margin:6pt 0;page-break-inside:avoid}
code{font-family:"DejaVu Sans Mono",monospace;font-size:8.8pt;background:var(--soft);padding:.5pt 3pt}
a{color:var(--info);text-decoration:none}
sub{display:block;margin-top:12pt;font-size:8.4pt;color:var(--mute);line-height:1.5}
.hd{margin-bottom:14pt}
.hd .sub{color:var(--mute);font-size:9.5pt}
`;

const title = opt('title') || 'Weekly Report';
const subtitle = opt('subtitle') || '';
const html =
  `<meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style>\n` +
  `<div class="hd"><h1>${esc(title)}</h1>` +
  (subtitle ? `<div class="sub">${esc(subtitle)}</div>` : '') +
  `</div>\n` +
  render(fs.readFileSync(src, 'utf8'));

const tmp = out.replace(/\.pdf$/, '') + '.html';
fs.writeFileSync(tmp, html);

const require = createRequire(projectDir.replace(/\/?$/, '/') + 'package.json');
const { chromium } = require('@playwright/test');
const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
await p.goto('file://' + tmp, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
const foot = esc(subtitle || title);
await p.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:7.5pt;color:#8a9099;padding:0 14mm;font-family:sans-serif">' +
    `<span style="float:left">${foot}</span>` +
    '<span style="float:right"><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
});
await b.close();
console.log(`[ok] ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
