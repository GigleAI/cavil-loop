#!/usr/bin/env node
/**
 * Review 截图共享脚本（一劳永逸版，源起 GigleTutor PR #446 复盘）。
 *
 * 解决的历史坑（每轮 worker 现写截图脚本反复踩）：
 *  1. 「只显示一半」：页面用 min-h-screen 布局，内容少时容器被视口撑高出大段空白，
 *     fullPage 截图把空白带 + footer 一起截进去 → 观感像只渲染了一半。
 *     → 本脚本按**内容实际底部**裁剪（跳过 footer / fixed/sticky 元素 / 撑满视口的包装容器）。
 *  2. 登录态失效：e2e auth storageState 的 origin 绑在 localhost:3000，worktree 预览端口
 *     不匹配 → localStorage 不注入，截出未登录页。
 *     → 传 AUTH_FILE 时自动把每个 origin 克隆一份到目标端口。
 *     登录状态文件里是真的登录令牌，副本只许待在原件旁边：原件必须在被 git 忽略的路径里、
 *     且不在截图输出目录内，否则直接报错不截图；副本权限 600，正常结束 / 出错 / 被中断都删掉。
 *     （截图输出目录通常就是公网资产目录，副本写进去就等于公开。）
 *  3. camo 缓存钉死旧图：由调用方传入唯一 REV（commit SHA + 纳秒），文件名自动带上。
 *
 * 用法：
 *   node review-screenshot.mjs \
 *     --port 4117 --out ~/.local/state/cavil-loop/review-shots/pr-446 \
 *     --rev "$(git rev-parse --short HEAD)-$(date +%s%N)" \
 *     [--auth e2e/.auth/user.json] [--viewport 1280x900] \
 *     --pages '/wrong-book=wrong-book,/knowledge-map=knowledge-map'
 *
 * --pages: 逗号分隔的 `路径=文件名` 对。输出 <out>/<文件名>-<rev>.png。
 * 依赖：调用方 cwd 下能 resolve @playwright/test（Tutor 等前端 repo 都有）。
 */
import { createRequire } from 'module';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname, relative, isAbsolute } from 'path';

const require = createRequire(join(process.cwd(), 'package.json'));
const { chromium } = require('@playwright/test');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const PORT = Number(args.port);
const OUT = args.out;
const REV = args.rev;
const PAGES = (args.pages || '/=home').split(',').map((p) => {
  const [path, name] = p.split('=');
  return { path, name: name || path.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home' };
});
const [VW, VH] = (args.viewport || '1280x900').split('x').map(Number);
if (!PORT || !OUT || !REV) {
  console.error('usage: review-screenshot.mjs --port N --out DIR --rev TOKEN [--auth FILE] [--viewport WxH] --pages "/a=a,/b=b"');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// auth storageState：克隆 origins 到目标端口（修坑 2）
let storageState;
let tmpAuth;
if (args.auth && existsSync(args.auth)) {
  const authReal = realpathSync(args.auth);
  const authDir = dirname(authReal);
  const outReal = realpathSync(OUT);
  const inside = (dir, p) => {
    const rel = relative(dir, p);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  if (inside(outReal, authReal)) {
    console.error(`拒绝：登录状态文件 ${args.auth} 在截图输出目录里。它含登录令牌，不能和要公开的截图放在一起；挪到项目里被 git 忽略的目录（如 e2e/.auth/）再来。`);
    process.exit(3);
  }
  let ignored = false;
  try {
    execFileSync('git', ['-C', authDir, 'check-ignore', '-q', authReal], { stdio: 'ignore' });
    ignored = true;
  } catch {
    ignored = false;
  }
  if (!ignored) {
    console.error(`拒绝：登录状态文件 ${args.auth} 不在被 git 忽略的路径里（git check-ignore 没认）。它含登录令牌，放在这里容易被提交；挪到被忽略的目录（如 e2e/.auth/）再来。`);
    process.exit(3);
  }
  const d = JSON.parse(readFileSync(authReal, 'utf8'));
  const extra = (d.origins || []).map((o) => ({ ...o, origin: `http://127.0.0.1:${PORT}` }));
  d.origins = [...(d.origins || []), ...extra];
  tmpAuth = join(authDir, `.review-clone-${PORT}-${Date.now()}-${process.pid}.json`);
  writeFileSync(tmpAuth, JSON.stringify(d), { mode: 0o600 });
  storageState = tmpAuth;
}
const dropClone = () => {
  if (tmpAuth) rmSync(tmpAuth, { force: true });
};
process.on('exit', dropClone);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    dropClone();
    process.exit(130);
  });
}
// 测试用：副本写好后停在这里等信号，用来验证被中断时副本会被删掉。
if (process.env.REVIEW_SHOT_TEST_HOLD === '1') {
  console.log(`hold: ${tmpAuth || '(no clone)'}`);
  await new Promise(() => setInterval(() => {}, 1000));
}

setTimeout(() => { console.log('overall timeout, force exit'); process.exit(2); }, 240000).unref();

let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: VW, height: VH },
    locale: 'zh-CN',
    ...(storageState ? { storageState } : {}),
  });
  const page = await ctx.newPage();
  for (const t of PAGES) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}${t.path}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
      // 内容实际底部（修坑 1）：跳过 footer / fixed/sticky / 撑满视口的包装容器
      const contentBottom = await page.evaluate(() => {
        const vh = window.innerHeight;
        let bottom = 0;
        const walk = (el) => {
          for (const c of el.children) {
            if (c.tagName === 'FOOTER' || c.tagName === 'SCRIPT' || c.tagName === 'STYLE') continue;
            const cs = getComputedStyle(c);
            if (cs.position === 'fixed' || cs.position === 'sticky') continue;
            const r = c.getBoundingClientRect();
            if (r.height > 0 && r.height < vh * 0.85) bottom = Math.max(bottom, r.bottom + window.scrollY);
            if (c.children.length) walk(c);
          }
        };
        walk(document.body);
        return Math.ceil(bottom) + 24;
      });
      const bodyH = await page.evaluate(() => document.body.scrollHeight);
      const clipH = Math.max(320, Math.min(contentBottom, bodyH));
      const file = `${OUT}/${t.name}-${REV}.png`;
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: VW, height: clipH }, fullPage: true });
      console.log(`shot: ${t.name}-${REV}.png (clip-h ${clipH})`);
    } catch (e) {
      console.log(`shot fail: ${t.name}: ${e.message}`);
    }
  }
} catch (e) {
  console.log('setup failed:', e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  dropClone();
  process.exit(0);
}
