// Local cache (SQLite, built into Node / Electron as `node:sqlite`).
// Only ever written from GitHub: a successful read of a source replaces that
// source's row in one transaction; nothing here is ever sent back up.
// Also keeps small settings (source list, view, client id override).
// Credentials are NOT stored here — they live in the platform credential store.

import { DatabaseSync } from 'node:sqlite';
import type { SourceSnapshot } from '../shared/types';

const SCHEMA_VERSION = 1;

export class Cache {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot (
        source_key TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS setting (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    const row = this.db.prepare(`SELECT v FROM meta WHERE k = 'schema'`).get() as { v: string } | undefined;
    if (!row) this.db.prepare(`INSERT INTO meta (k, v) VALUES ('schema', ?)`).run(String(SCHEMA_VERSION));
    else if (Number(row.v) !== SCHEMA_VERSION) {
      // The cache is rebuildable from GitHub; an unknown layout is simply dropped.
      this.db.exec(`DELETE FROM snapshot;`);
      this.db.prepare(`UPDATE meta SET v = ? WHERE k = 'schema'`).run(String(SCHEMA_VERSION));
    }
  }

  /** Replace whole snapshots (one row per source) atomically. */
  replaceSnapshots(snaps: SourceSnapshot[]): void {
    if (snaps.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO snapshot (source_key, fetched_at, data) VALUES (?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`,
    );
    this.db.exec('BEGIN');
    try {
      for (const s of snaps) stmt.run(s.sourceKey, s.fetchedAt, JSON.stringify(s));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  loadSnapshots(): Map<string, SourceSnapshot> {
    const out = new Map<string, SourceSnapshot>();
    for (const row of this.db.prepare(`SELECT source_key, data FROM snapshot`).all() as { source_key: string; data: string }[]) {
      try {
        out.set(row.source_key, JSON.parse(row.data) as SourceSnapshot);
      } catch {
        /* a corrupt row is dropped; the next sync rewrites it */
      }
    }
    return out;
  }

  deleteSnapshot(sourceKey: string): void {
    this.db.prepare(`DELETE FROM snapshot WHERE source_key = ?`).run(sourceKey);
  }

  getSetting<T>(k: string, fallback: T): T {
    const row = this.db.prepare(`SELECT v FROM setting WHERE k = ?`).get(k) as { v: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.v) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(k: string, v: unknown): void {
    this.db
      .prepare(`INSERT INTO setting (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(k, JSON.stringify(v));
  }

  close(): void {
    this.db.close();
  }
}
