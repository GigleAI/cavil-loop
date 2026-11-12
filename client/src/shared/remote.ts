// A daemon on another machine (GitHub#387), as the settings page shows it. The back end
// (src-tauri/crates/core/src/remote.rs) holds the key, checks that the connection is the paired
// Tailscale machine and signs every request; this file only has the shapes and the wording.

import type { LocalStatus, SchedState } from './daemon';

export interface RemoteEntry {
  /** `<host>:<port>` */
  id: string;
  host: string;
  port: number;
  /** this computer's id on that machine (what `remote-access.sh revoke` takes) */
  device: string;
  /** `pending_revoke`: unpaired here while the machine could not confirm — its authorization may still stand */
  state: 'paired' | 'pending_revoke';
  paired_at: number;
  /** the last status that was read whole, and when (epoch seconds) */
  last: { at: number; status: LocalStatus } | null;
}

export interface RemoteList {
  remotes: RemoteEntry[];
  /** false: this platform keeps keys for this run only */
  persistent: boolean;
}

/** One read of a machine: its status, or why there is none (never "no projects"). */
export interface RemoteOk {
  state: 'ok';
  status: LocalStatus;
  at: number;
}
export interface RemoteFail {
  /** why not: unreachable / not_tailscale / identity / mismatch / revoked / … */
  state: string;
  message: string;
}
export type RemoteRead = RemoteOk | RemoteFail;

export function readOk(r: RemoteRead | null | undefined): r is RemoteOk {
  return !!r && r.state === 'ok' && 'status' in r;
}

export interface RemoteResult {
  /** paired / unpaired / pending / unconfirmed / ok / failed / refused / not_found / unknown */
  result: string;
  reason?: string;
  output?: string;
  state?: SchedState;
  id?: string;
  text?: string;
  path?: string;
  exists?: boolean;
}

/** The short name shown for a machine: the first label of its Tailscale name. */
export function remoteName(host: string): string {
  return host.split('.')[0] || host;
}

/** The command that revokes this computer on that machine, for a person to paste there. */
export function revokeCommand(e: Pick<RemoteEntry, 'device'>): string {
  return `bash ~/.agents/skills/cavil-loop/scripts/remote-access.sh revoke ${e.device}`;
}

export const PAIR_COMMAND = 'bash ~/.agents/skills/cavil-loop/scripts/remote-access.sh pair';

/** A pairing code as typed: digits only, at most 8 (spaces and dashes are how people copy it). */
export function codeDigits(typed: string): string {
  return typed.replace(/\D/g, '').slice(0, 8);
}

/** What the pill of one machine says. */
export function remotePill(e: RemoteEntry, reading: boolean, read: RemoteRead | null): { word: string; tone: 'ok' | 'bad' | 'busy' } {
  if (e.state === 'pending_revoke') return { word: '取消配对未完成', tone: 'bad' };
  if (reading) return { word: '正在读取…', tone: 'busy' };
  if (!read) return { word: '还没读取', tone: 'busy' };
  if (readOk(read)) return { word: '已连接', tone: 'ok' };
  if (read.state === 'revoked') return { word: '配对已失效', tone: 'bad' };
  if (read.state === 'mismatch' || read.state === 'identity') return { word: '不是那台机器', tone: 'bad' };
  if (read.state === 'not_tailscale') return { word: '不在 Tailscale 上', tone: 'bad' };
  return { word: '连不上', tone: 'bad' };
}

export function clock(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── picking a machine instead of typing its name ──

/** one machine in this computer's Tailscale */
export interface TailnetDevice {
  host: string;
  name: string;
  os: string;
  online: boolean;
  /** open: its remote entry answered · closed: nothing listens there · unknown: could not tell (never "closed") · offline: not asked */
  remote: 'open' | 'closed' | 'unknown' | 'offline';
  why?: string;
}
export type TailnetList = { result: 'ok'; devices: TailnetDevice[] } | { result: 'unreadable'; output: string };

/** What the pill of a machine in the list says. */
export function tailnetPill(d: TailnetDevice): { word: string; tone: 'ok' | 'bad' | 'busy' | 'none' } {
  switch (d.remote) {
    case 'open':
      return { word: '已打开远程连接', tone: 'ok' };
    case 'closed':
      return { word: '未打开远程连接', tone: 'none' };
    case 'offline':
      return { word: '不在线', tone: 'none' };
    default:
      return { word: '不确定', tone: 'busy' };
  }
}

/** Open ones first, then could-not-tell, then closed, then offline; by name within each. */
export function sortTailnet(list: TailnetDevice[]): TailnetDevice[] {
  const rank = { open: 0, unknown: 1, closed: 2, offline: 3 } as const;
  return [...list].sort((a, b) => rank[a.remote] - rank[b.remote] || a.host.localeCompare(b.host));
}

// ── this machine as the one being connected to ──

export type HostAction = 'status' | 'enable' | 'disable' | 'code' | 'cancel' | 'devices' | 'revoke';

/** open / closed / partial (half open or half closed) / unknown (could not read: the switch is not offered) / missing (daemon too old or not installed) */
export interface HostStatus {
  state: 'open' | 'closed' | 'partial' | 'unknown' | 'missing';
  host?: string | null;
  devices?: number | null;
  output?: string;
}

export interface HostDevice {
  id: string;
  name: string;
  node: string;
  paired: string;
}

export interface HostResult {
  result: string;
  output?: string;
  /** enable / disable: what a fresh read says afterwards */
  status?: HostStatus;
  code?: string;
  /** epoch seconds */
  expires?: number;
  host?: string | null;
  devices?: HostDevice[];
}

/** "4827 1930" */
export function spacedCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

/** "9 分 42 秒" — what is left of a code; null once it has run out. */
export function codeLeft(expires: number, nowSec: number): string | null {
  const s = Math.floor(expires - nowSec);
  if (s <= 0) return null;
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}
