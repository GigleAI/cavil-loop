#!/usr/bin/env node
// 把本地 HTML 渲染成 ~1280px 单倍像素 PNG（GitHub 评论配图标准，见 AGENTS.md）。
// 用法: shot.mjs <node-project-dir> <src.html> <out.png>
import { createRequire } from 'module';
const [, , projectDir, src, out] = process.argv;
const require = createRequire(projectDir.replace(/\/?$/, '/') + 'package.json');
const { chromium } = require('@playwright/test');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
await p.goto('file://' + src, { waitUntil: 'load' });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(400);
const el = await p.$('.wrap');
await el.screenshot({ path: out });
const box = await el.boundingBox();
console.log(`[ok] ${out} ${Math.round(box.width)}x${Math.round(box.height)}`);
await b.close();
