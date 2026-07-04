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
 *  3. camo 缓存钉死旧图：由调用方传入唯一 REV（commit SHA + 纳秒），文件名自动带上。
 *
 * 用法：
 *   node review-screenshot.mjs \
 *     --port 4117 --out ~/.local/state/coding-agent-poll/review-shots/pr-446 \
 *     --rev "$(git rev-parse --short HEAD)-$(date +%s%N)" \
 *     [--auth e2e/.auth/user.json] [--viewport 1280x900] \
 *     --pages '/wrong-book=wrong-book,/knowledge-map=knowledge-map'
 *
 * --pages: 逗号分隔的 `路径=文件名` 对。输出 <out>/<文件名>-<rev>.png。
 * 依赖：调用方 cwd 下能 resolve @playwright/test（Tutor 等前端 repo 都有）。
 */
import { createRequire } from 'module';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
  const d = JSON.parse(readFileSync(args.auth, 'utf8'));
  const extra = (d.origins || []).map((o) => ({ ...o, origin: `http://127.0.0.1:${PORT}` }));
  d.origins = [...(d.origins || []), ...extra];
  tmpAuth = join(tmpdir(), `review-auth-${PORT}-${Date.now()}.json`);
  writeFileSync(tmpAuth, JSON.stringify(d));
  storageState = tmpAuth;
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
  if (tmpAuth) rmSync(tmpAuth, { force: true });
  process.exit(0);
}
