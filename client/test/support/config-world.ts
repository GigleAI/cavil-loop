// GitHub#649: the machine the "配置" tests run the daemon's real project-config.sh on — built once per
// test file (fake tools, the daemon cloned, a project connected with the real setup.sh) under its own
// time limit, a fresh copy for every case. Shared by test/unit/project-config*.test.ts, so the value
// checks can run in a file of their own, side by side with the rest.

import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from './credentials';
import { HarnessBackend } from './harness';
import { connect, daemonEnv, daemonWorld, dropWorlds, installByHand, pathFor, restoreWorld, snapshotWorld, type DaemonWorld, type Os } from './daemon-world';
import type { ProjectConfig } from '../../src/shared/daemon';
import { tempDir } from '../unit/helpers';

export interface ConfigWorld {
  readonly w: DaemonWorld;
  readonly path: string;
  readonly config: string;
  backend(os?: Os, p?: string): HarnessBackend;
  line(name: string): string[];
  byName(c: ProjectConfig, name: string): ProjectConfig['fields'][number];
}

/** Registers the hooks of the enclosing describe block and gives the cases their machine. */
export function configWorld(): ConfigWorld {
  const open: HarnessBackend[] = [];
  let w!: DaemonWorld;
  let path = '';
  let config = '';
  let snap = '';
  beforeAll(() => {
    w = daemonWorld(tempDir());
    installByHand(w);
    path = pathFor(w);
    const host = connect(w, 'widget', 'Darwin', path);
    config = join(host, 'cavil-loop.config');
    snap = snapshotWorld(w);
  }, 120_000);
  beforeEach(() => {
    restoreWorld(w, snap);
  }, 30_000);
  afterEach(async () => {
    await Promise.all(open.splice(0).map((b) => b.close()));
  });
  // the machine and its copy go when the block is done (~2300 files, GitHub#469)
  afterAll(() => {
    dropWorlds();
  }, 60_000);
  return {
    get w() {
      return w;
    },
    get path() {
      return path;
    },
    get config() {
      return config;
    },
    backend(os: Os = 'Darwin', p = path) {
      const b = new HarnessBackend({
        db: join(w.dir, `cache-${open.length}.sqlite`),
        endpoints: { api: 'http://127.0.0.1:9', web: 'http://127.0.0.1:9' },
        credentials: new MemoryStore(),
        env: daemonEnv(w, { os, path: p }),
      });
      open.push(b);
      return b;
    },
    line: (name: string) => readFileSync(config, 'utf8').split('\n').filter((l) => l.startsWith(`${name}=`)),
    byName: (c: ProjectConfig, name: string) => c.fields.find((f) => f.name === name)!,
  };
}
