// 公网资产目录的放行规则——serve.mjs（对外服务）和 check.mjs（发图前自查）共用这一份。
//
// 为什么有这个目录：评论配图要能被 GitHub 抓到，所以资产目录经公网隧道对外。把目录直接交给
// 静态文件服务器，它会列出文件名，也会把目录里的任何文件原样交出去——日志、测试报告、
// 登录状态文件一旦被放进来就等于公开。这里只放行「扩展名是图片 / 视频，而且内容确实是
// 那种格式」的文件，其余一律当作不存在。
import fs from 'fs';
import path from 'path';

export const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

// 凭证样式：[名字, 完整样式, 「还没读完」样式]。名字只用于报告「命中了哪一类」，值从不输出。
// 第三项给分块扫描用（见 findSecretsInFile）：它匹配「一条可能的凭证从某处开始、一直延伸到
// 当前已读内容的末尾、还差后半截」的情形，必须以 $ 结尾。完整样式里凡是「一段不限长的内容
// 后面还要跟别的东西才算数」的（JWT 的三段、带引号的字段值、连接串的密码……），都要配这一项；
// 靠固定长度就能认出来的（开头几十个字符就够）不用配，由固定重叠兜住。
export const SECRET_PATTERNS = [
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  [
    'jwt',
    /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/,
    /eyJ[A-Za-z0-9_-]{15,}(?:\.(?:e(?:y(?:J[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]{0,9})?)?)?)?)?$/,
  ],
  [
    'token-field',
    /["']?(?:refresh_token|access_token)["']?\s*[:=]\s*["'][^"']{12,}["']/,
    /(?:refresh_token|access_token)["']?\s*(?:[:=]\s*(?:["'][^"']*)?)?$/,
  ],
  ['auth-token-key', /sb-[a-z0-9]+-auth-token/, /sb-[a-z0-9]+(?:-[a-z-]{0,10})?$/],
  ['service-role', /service_role|SERVICE_ROLE_KEY/],
  ['api-key', /\bsk-[A-Za-z0-9_-]{24,}|sb_secret_[A-Za-z0-9_-]{10,}|\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY/, /-----BEGIN [A-Z ]*$/],
  [
    'db-url-password',
    /postgres(?:ql)?:\/\/[^\s:/@]+:[^\s@/]{4,}@/,
    /postgres(?:ql)?:\/\/[^\s:/@]*(?::[^\s@/]*)?$/,
  ],
  ['bearer', /Bearer\s+[A-Za-z0-9._-]{30,}/, /Bearer\s+[A-Za-z0-9._-]{0,29}$/],
];

export function findSecrets(text) {
  const kinds = [];
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) kinds.push(name);
  return kinds;
}

// 整个文件扫一遍凭证样式，不论多大，结果不随凭证在文件里的位置变。
//
// 按块读。每读完一块，除了找完整的凭证，还要看块尾有没有「开了头、还没读完」的凭证
// （上表第三项）：有，就从它开头的地方起整段留下，和下一块接起来再判——不是只留固定的几 KB。
// 固定留几 KB 是不够的：一条 8KB 的 JWT 起点落在块尾前 5KB 时，前一块还没读到第三段、
// 后一块已经丢了开头，两边都认不出来。
// 另外总是至少留 SCAN_MIN_OVERLAP_BYTES，兜住被块边界切开的固定前缀（如 refresh_tok|en）。
//
// 留下的部分有上限（SCAN_MAX_PENDING_BYTES）。一条疑似凭证延伸超过这个长度还没读完时，
// 不当成「没命中」——报 UNRESOLVED_KIND，调用方按含凭证处理（拒绝发布）。
// 没有大小上限、也没有「太大就跳过」：没判清的文件不能当成没有凭证。
export const SCAN_CHUNK_BYTES = 1024 * 1024;
export const SCAN_MIN_OVERLAP_BYTES = 256;
export const SCAN_MAX_PENDING_BYTES = 1024 * 1024;
export const UNRESOLVED_KIND = '疑似凭证超过 1MiB 仍未读完，无法判定';

export function findSecretsInFile(file) {
  const kinds = new Set();
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(SCAN_CHUNK_BYTES);
    let pending = '';
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, SCAN_CHUNK_BYTES, pos);
      if (n <= 0) break;
      pos += n;
      const text = pending + buf.toString('latin1', 0, n);
      for (const k of findSecrets(text)) kinds.add(k);
      let keepFrom = Math.max(0, text.length - SCAN_MIN_OVERLAP_BYTES);
      for (const [, , open] of SECRET_PATTERNS) {
        if (!open) continue;
        const m = open.exec(text);
        if (m && m.index < keepFrom) keepFrom = m.index;
      }
      if (text.length - keepFrom > SCAN_MAX_PENDING_BYTES) {
        kinds.add(UNRESOLVED_KIND);
        keepFrom = text.length - SCAN_MIN_OVERLAP_BYTES;
      }
      pending = text.slice(keepFrom);
    }
  } finally {
    fs.closeSync(fd);
  }
  return [...kinds];
}

const ascii = (buf, start, end) => buf.subarray(start, end).toString('latin1');

// 文件开头的字节是不是这个扩展名该有的格式。只看开头：目的是挡住「把别的东西改个名字」，
// 不是完整解码。
export function looksLike(ext, head) {
  switch (ext) {
    case 'png':
      return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
    case 'jpeg':
      return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'gif':
      return ['GIF87a', 'GIF89a'].includes(ascii(head, 0, 6));
    case 'webp':
      return ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP';
    case 'avif':
      return ascii(head, 4, 8) === 'ftyp' && /avif|avis|mif1|msf1/.test(ascii(head, 8, 32));
    case 'mp4':
    case 'mov':
      return ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(ascii(head, 4, 8));
    case 'webm':
      return head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    default:
      return false;
  }
}

const HEAD_BYTES = 64;
const SVG_MAX_BYTES = 8 * 1024 * 1024;

function readHead(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0));
  } finally {
    fs.closeSync(fd);
  }
}

// 判一个文件能不能对外：{ ok: true, type, size } 或 { ok: false, reason }。
// root 与 file 都必须是已解析符号链接后的真实路径（调用方负责），这里再核一遍包含关系。
export function judgeFile(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: '路径不在资产目录内' };
  if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return { ok: false, reason: '路径里有以 . 开头的段' };
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: false, reason: '文件不存在' };
  }
  if (!st.isFile()) return { ok: false, reason: '不是普通文件（目录不对外）' };
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) return { ok: false, reason: `扩展名 .${ext || '(无)'} 不是图片 / 视频` };
  if (ext === 'svg') {
    if (st.size > SVG_MAX_BYTES) return { ok: false, reason: 'SVG 超过 8MB' };
    const text = fs.readFileSync(file, 'utf8');
    if (!/<svg[\s>]/i.test(text.slice(0, 4096))) return { ok: false, reason: '内容不是 SVG' };
    const kinds = findSecrets(text);
    if (kinds.length) return { ok: false, reason: `SVG 内容里有凭证样式（${kinds.join('、')}）` };
  } else if (!looksLike(ext, readHead(file, HEAD_BYTES))) {
    return { ok: false, reason: `内容不是 .${ext} 格式` };
  }
  return { ok: true, type, size: st.size, mtimeMs: st.mtimeMs };
}

// 把请求路径解析成资产目录里的真实文件路径；解析不出来或逃出目录返回 null。
export function resolveInRoot(root, relPath) {
  if (relPath.includes('\0')) return null;
  const joined = path.join(root, relPath);
  let real;
  try {
    real = fs.realpathSync(joined);
  } catch {
    return null;
  }
  const rel = path.relative(root, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return real;
}
