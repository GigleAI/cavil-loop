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

// 凭证样式。名字只用于报告「命中了哪一类」，值从不输出。
export const SECRET_PATTERNS = [
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ['token-field', /["']?(?:refresh_token|access_token)["']?\s*[:=]\s*["'][^"']{12,}["']/],
  ['auth-token-key', /sb-[a-z0-9]+-auth-token/],
  ['service-role', /service_role|SERVICE_ROLE_KEY/],
  ['api-key', /\bsk-[A-Za-z0-9_-]{24,}|sb_secret_[A-Za-z0-9_-]{10,}|\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['db-url-password', /postgres(?:ql)?:\/\/[^\s:/@]+:[^\s@/]{4,}@/],
  ['bearer', /Bearer\s+[A-Za-z0-9._-]{30,}/],
];

export function findSecrets(text) {
  const kinds = [];
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) kinds.push(name);
  return kinds;
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
