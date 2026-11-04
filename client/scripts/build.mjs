#!/usr/bin/env node
// Build: main + preload with esbuild (CommonJS, Electron loads them),
// renderer with Vite. Output in dist/.
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: true, logLevel: 'warning' };
await esbuild({ ...common, entryPoints: [join(root, 'src/main/main.ts')], outfile: join(root, 'dist/main/main.cjs') });
await esbuild({ ...common, entryPoints: [join(root, 'src/preload/preload.ts')], outfile: join(root, 'dist/preload/preload.cjs') });
await vite({
  root: join(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  logLevel: 'warn',
  build: { outDir: join(root, 'dist/renderer'), emptyOutDir: true, sourcemap: true, target: 'chrome130' },
});
console.log('built dist/');
